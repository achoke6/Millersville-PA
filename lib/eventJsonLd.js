/**
 * lib/eventJsonLd.js — Generate schema.org Event JSON-LD from the site's event
 * objects, for Google rich results ("Events" / "Things to do").
 *
 * WHY a shared module (like lib/eventMatch.js): the mapping has fiddly rules
 * (which events qualify, date→ISO-with-offset, escaping) that are far easier to
 * unit-test in isolation than buried inside scrape.js. scrape.js requires this
 * at build time and writes the result into index.html between the
 * <!-- JSONLD:START --> / <!-- JSONLD:END --> markers.
 *
 * IMPORTANT — Google's requirements this module is built around:
 *   - Structured data must be in the HTML at crawl time. The site renders
 *     events client-side from events.json, so at crawl time the DOM has no
 *     events. Hence we bake the JSON-LD into index.html at build time instead
 *     of injecting it from app.js in the browser.
 *   - startDate/endDate MUST carry a timezone offset (e.g. 2026-08-04T18:00:00
 *     -04:00). A bare "YYYY-MM-DDTHH:MM" is rejected/misread. We derive the
 *     correct EDT/EST offset per-date (DST-aware) from the event instant.
 *   - location needs a name (and address if we have one) or, for purely online
 *     things, a VirtualLocation. We use Place with whatever address text we have.
 *
 * QUALITY over QUANTITY: emitting ~900 Events — including recurring municipal
 * trash/recycling/yard-waste "events" — would bloat the page and looks spammy
 * (Google may flag low-value/duplicative Event markup). So generateEventJsonLd
 * curates: upcoming only, recurring municipal collections excluded, capped.
 *
 * UMD-style export: works as a CommonJS module in Node (scrape.js) and is inert
 * if ever loaded in a browser (it doesn't run anything on load).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.eventJsonLd = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SITE_NAME = 'Millersville.APP';
  var SITE_URL = 'https://millersville.app/';

  // Strip C0/C1 control characters from text before it goes into JSON-LD.
  // JSON.stringify would *escape* a stray control char (e.g. U+0002) to \u0002,
  // which is valid JSON — but Google's structured-data parser still rejects a
  // control character inside a text value ("Incorrect value type" / unparsable).
  // Source data occasionally carries these (e.g. a mangled "multi-day" where the
  // hyphen became U+0002). We replace them with a space and collapse runs. We
  // KEEP tab/newline/carriage-return (\u0009/\u000A/\u000D) since those are legal.
  function clean(s) {
    if (s == null) return s;
    return String(s)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  // --- date handling: resolve any event date string to a UTC instant, then
  // render it as an ISO-8601 string carrying the correct America/New_York
  // offset for THAT date (handles EDT vs EST automatically). Mirrors
  // scrape.js's parseEventInstant semantics so a no-offset "wall clock" string
  // is interpreted as ET, not UTC.
  function parseInstant(s) {
    if (!s) return NaN;
    var str = String(s).trim();
    if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(str)) return new Date(str).getTime();
    var m = str.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return NaN;
    var candidate = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    var dt = new Date(candidate);
    var fmt = function (tz) {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      });
    };
    var partsToMs = function (parts) {
      var g = function (t) { var p = parts.find(function (x) { return x.type === t; }); return p ? p.value : '0'; };
      return Date.UTC(+g('year'), +g('month') - 1, +g('day'), +g('hour') % 24, +g('minute'), +g('second'));
    };
    var offsetMs = partsToMs(fmt('America/New_York').formatToParts(dt))
                 - partsToMs(fmt('UTC').formatToParts(dt));
    return candidate - offsetMs;
  }

  // UTC instant -> "YYYY-MM-DDTHH:MM:SS-04:00" in America/New_York.
  function toEtIso(ms) {
    if (isNaN(ms)) return null;
    var dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
    var parts = dtf.formatToParts(new Date(ms));
    var g = function (t) { var p = parts.find(function (x) { return x.type === t; }); return p ? p.value : '00'; };
    var local = Date.UTC(+g('year'), +g('month') - 1, +g('day'), +g('hour') % 24, +g('minute'), +g('second'));
    var offMin = Math.round((local - ms) / 60000); // minutes ET is ahead of UTC (negative)
    var sign = offMin <= 0 ? '-' : '+';
    var abs = Math.abs(offMin);
    var oh = String(Math.floor(abs / 60)).padStart(2, '0');
    var om = String(abs % 60).padStart(2, '0');
    return g('year') + '-' + g('month') + '-' + g('day') + 'T' +
           (g('hour') % 24 === 0 ? '00' : g('hour')) + ':' + g('minute') + ':' + g('second') +
           sign + oh + ':' + om;
  }

  // Just the ET calendar date (no time) for all-day events.
  function toEtDate(ms) {
    if (isNaN(ms)) return null;
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date(ms));
    var g = function (t) { var p = parts.find(function (x) { return x.type === t; }); return p ? p.value : ''; };
    return g('year') + '-' + g('month') + '-' + g('day');
  }

  // Recurring/low-value civic items — valid events, but low-value and
  // duplicative as rich-results structured data (Google may flag low-value or
  // spammy Event markup), so excluded from the feed. Covers: municipal
  // collection days; routine public bodies (council/commission/committee/
  // board/authority/zoning/planning — matched as a trailing word so "Park
  // Commission" and "Planning Commission" are caught even without "meeting");
  // posted agendas; and academic-calendar status markers ("… BEGINS/ENDS",
  // "Summer Session …") that aren't attendable events.
  var EXCLUDE_RE = /trash|recycling|yard waste|appliance|leaf collection|bulk (pickup|collection)|\bcollection\b|\b(council|commission|committee|board|authority|zoning|planning)\b|\bmeeting\b|agenda|\b(begins|ends)\b|summer session|winter session|finals week|reading day/i;

  // Canceled events shouldn't be advertised as EventScheduled. We detect a
  // "CANCELED/CANCELLED" title prefix and skip (could instead emit
  // EventCancelled, but dropping is simpler and avoids surfacing dead events).
  var CANCELED_RE = /^\s*cancel?led\b|\bcancel?led:/i;

  function isExcluded(e) {
    var t = e.title || '';
    return EXCLUDE_RE.test(t) || CANCELED_RE.test(t);
  }

  // Decide event vs. EventSeries is overkill here; we emit single Events.
  // Returns a schema.org Event object, or null if unusable (no resolvable date).
  function toSchemaEvent(e) {
    var ms = parseInstant(e.date);
    if (isNaN(ms)) return null;

    var allDay = e.allDay === true;
    var obj = {
      '@type': 'Event',
      name: clean(e.title) || 'Event',
      startDate: allDay ? toEtDate(ms) : toEtIso(ms),
      eventStatus: 'https://schema.org/EventScheduled',
      eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode'
    };

    // End date — only if present and after start.
    if (e.endTime) {
      var endMs = parseInstant(e.endTime);
      if (!isNaN(endMs) && endMs > ms) obj.endDate = allDay ? toEtDate(endMs) : toEtIso(endMs);
    }

    // Location — Place with name + address text when we have it.
    var loc = clean(e.location) || '';
    if (loc) {
      obj.location = {
        '@type': 'Place',
        name: loc,
        address: { '@type': 'PostalAddress', addressLocality: 'Millersville', addressRegion: 'PA', addressCountry: 'US' }
      };
      // If the location string itself looks like a street address, use it as streetAddress.
      if (/\d/.test(loc) && /(st|street|rd|road|ave|avenue|dr|drive|ln|lane|blvd|way|pike|hwy)\b/i.test(loc)) {
        obj.location.address.streetAddress = loc;
      }
    } else {
      obj.location = {
        '@type': 'Place', name: 'Millersville, PA',
        address: { '@type': 'PostalAddress', addressLocality: 'Millersville', addressRegion: 'PA', addressCountry: 'US' }
      };
    }

    var desc = clean(e.description);
    if (desc) obj.description = desc;
    if (e.image) obj.image = e.image;

    // Organizer from orgName when available.
    if (e.orgName) obj.organizer = { '@type': 'Organization', name: clean(e.orgName) };

    // Offers — only for free or ticketed events with a link. We avoid inventing
    // prices (we don't have numeric prices), so paid events without a number
    // just carry a url offer.
    var priceStr = (e.price || '').toString().trim();
    var ticket = e.ticketLink || e.registerLink || '';
    if (/free/i.test(priceStr)) {
      obj.offers = {
        '@type': 'Offer', price: '0', priceCurrency: 'USD',
        availability: 'https://schema.org/InStock',
        url: ticket || e.sourceLink || SITE_URL
      };
    } else if (ticket) {
      obj.offers = { '@type': 'Offer', url: ticket, availability: 'https://schema.org/InStock' };
    }

    // A canonical URL for the event: prefer its source link.
    if (e.sourceLink) obj.url = e.sourceLink;

    return obj;
  }

  /**
   * generateEventJsonLd(events, opts)
   *   events: array of the site's event objects.
   *   opts.now:   reference time in ms (default Date.now()) — events before this
   *               (by end time if present, else start) are dropped.
   *   opts.limit: max events to include (default 75).
   *   opts.includePast: if true, skip the upcoming-only filter (testing).
   * Returns the JSON-LD STRING (an ItemList of Events), or '' if none qualify.
   */
  function generateEventJsonLd(events, opts) {
    opts = opts || {};
    var now = typeof opts.now === 'number' ? opts.now : Date.now();
    var limit = typeof opts.limit === 'number' ? opts.limit : 30;
    if (!Array.isArray(events)) return '';

    var qualifying = events.filter(function (e) {
      if (!e || isExcluded(e)) return false;
      var ms = parseInstant(e.date);
      if (isNaN(ms)) return false;
      if (opts.includePast) return true;
      // Keep if it hasn't ended yet (use endTime when available, else start +
      // 3h grace so an in-progress/just-started event isn't dropped).
      var endMs = e.endTime ? parseInstant(e.endTime) : NaN;
      var effectiveEnd = !isNaN(endMs) ? endMs : ms + 3 * 60 * 60 * 1000;
      return effectiveEnd >= now;
    });

    qualifying.sort(function (a, b) { return parseInstant(a.date) - parseInstant(b.date); });
    qualifying = qualifying.slice(0, limit);

    var items = [];
    for (var i = 0; i < qualifying.length; i++) {
      var se = toSchemaEvent(qualifying[i]);
      if (se) items.push({ '@type': 'ListItem', position: items.length + 1, item: se });
    }
    if (!items.length) return '';

    // Carousel/ItemList rich results require each item's URL to be UNIQUE.
    // Some events legitimately share one landing page — e.g. every week of the
    // Summer Fun Series links to the same alumni page — so two items can end up
    // with identical urls. Google flags that on the carousel interpretation as
    // "Identical property values given, but unique values are required" and
    // invalidates the carousel (the individual Events stay valid either way).
    // Fix: give the 2nd+ occurrence a distinguishing #fragment. The server
    // ignores the fragment, so the link still resolves to the same page, but
    // the URLs are now distinct. First occurrence is left untouched.
    var seenUrls = Object.create(null);
    for (var u = 0; u < items.length; u++) {
      var ev = items[u].item;
      if (!ev || !ev.url) continue;            // events without a url can't collide
      if (!seenUrls[ev.url]) { seenUrls[ev.url] = true; continue; }
      var base = ev.url;
      var tag = (typeof ev.startDate === 'string' ? ev.startDate.slice(0, 10) : '') || ('item-' + items[u].position);
      var candidate = base + '#' + tag;
      var n = 2;
      while (seenUrls[candidate]) candidate = base + '#' + tag + '-' + (n++); // same url+date repeated
      ev.url = candidate;
      seenUrls[candidate] = true;
    }

    var doc = {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: 'Upcoming events in Millersville, PA',
      itemListElement: items
    };

    // Minified (Google ignores whitespace; keeps the injected HTML small),
    // then neutralize any "</script" that could prematurely close the host
    // <script> tag when embedded in HTML (standard JSON-LD hardening).
    var json = JSON.stringify(doc).replace(/<\/(script)/gi, '<\\/$1');
    return json;
  }

  return {
    generateEventJsonLd: generateEventJsonLd,
    // exported for unit tests:
    _toSchemaEvent: toSchemaEvent,
    _parseInstant: parseInstant,
    _toEtIso: toEtIso,
    _isExcluded: isExcluded
  };
}));
