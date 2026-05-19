/* =========================================================
   ICY METADATA
========================================================= */
export const IcyMeta = (() => {
  const titleEl = document.getElementById('title');
  const panelEl = document.getElementById('station-meta');
  const STORAGE_KEY = 'icymeta_cache';
  const TRACK_POLL_MS = 30000;
  const MAX_TRACK_BYTES = 128 * 1024;

  let activeUrl = null;
  let activeMeta = null;
  let activeTrack = null;
  let trackController = null;
  let trackTimer = null;

  function esc(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  
  function _loadCache() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch { return {}; }
  }

  function _saveCache(cache) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
    } catch { /* storage full or unavailable */ }
  }

  function _parseStreamTitle(metadataText) {
    const match = metadataText.match(/StreamTitle='([^']*)'/i)
      || metadataText.match(/StreamTitle="([^"]*)"/i);
    return match?.[1]?.trim() || null;
  }

  function _canAttemptTrackFetch(url) {
    try {
      const streamUrl = new URL(url, window.location.href);
      return !(window.location.protocol === 'https:' && streamUrl.protocol === 'http:');
    } catch (_) {
      return false;
    }
  }

  function _fallbackStationName() {
    try {
      return new URL(activeUrl, window.location.href).hostname || 'Live Stream';
    } catch (_) {
      return 'Live Stream';
    }
  }

  function _decodeTrackChunk(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;

    parts.forEach(part => {
      bytes.set(part, offset);
      offset += part.length;
    });

    return new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/\0+$/g, '');
  }

  async function fetchTrackTitle(url, signal) {
    const res = await fetch(url, {
      cache: 'no-store',
      redirect: 'follow',
      signal,
      headers: { 'Icy-MetaData': '1' },
    });
    const metaInterval = Number(res.headers.get('icy-metaint'));

    if (!res.body) return null;

    if (!Number.isFinite(metaInterval) || metaInterval <= 0) {
      const track = await _scanTrackTitle(res.body);
      try { await res.body?.cancel(); } catch (_) {}
      return track;
    }

    const reader = res.body.getReader();
    let audioUntilMeta = metaInterval;
    let metadataLength = null;
    let metadataParts = [];
    let bytesRead = 0;

    try {
      while (bytesRead < MAX_TRACK_BYTES) {
        const { done, value } = await reader.read();
        if (done || !value) break;

        bytesRead += value.length;
        let offset = 0;

        while (offset < value.length) {
          if (audioUntilMeta > 0) {
            const skip = Math.min(audioUntilMeta, value.length - offset);
            audioUntilMeta -= skip;
            offset += skip;
            continue;
          }

          if (metadataLength === null) {
            metadataLength = value[offset] * 16;
            metadataParts = [];
            offset += 1;

            if (metadataLength === 0) {
              audioUntilMeta = metaInterval;
              metadataLength = null;
            }

            continue;
          }

          const take = Math.min(metadataLength, value.length - offset);
          metadataParts.push(value.slice(offset, offset + take));
          metadataLength -= take;
          offset += take;

          if (metadataLength === 0) {
            const track = _parseStreamTitle(_decodeTrackChunk(metadataParts));
            if (track) return track;

            audioUntilMeta = metaInterval;
            metadataLength = null;
          }
        }
      }
    } finally {
      try { await reader.cancel(); } catch (_) {}
    }

    return null;
  }

  async function _scanTrackTitle(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder('iso-8859-1');
    let bytesRead = 0;
    let textTail = '';

    try {
      while (bytesRead < MAX_TRACK_BYTES) {
        const { done, value } = await reader.read();
        if (done || !value) break;

        bytesRead += value.length;
        textTail += decoder.decode(value, { stream: true });

        const track = _parseStreamTitle(textTail);
        if (track) return track;

        textTail = textTail.slice(-512);
      }
    } finally {
      try { await reader.cancel(); } catch (_) {}
    }

    return null;
  }

  function _stopTrackUpdates() {
    clearTimeout(trackTimer);
    trackTimer = null;

    if (trackController) {
      trackController.abort();
      trackController = null;
    }
  }

  function _startTrackUpdates(url) {
    _stopTrackUpdates();
    if (!_canAttemptTrackFetch(url)) return;

    const poll = async () => {
      if (url !== activeUrl) return;

      trackController = new AbortController();

      try {
        const track = await fetchTrackTitle(url, trackController.signal);

        if (url === activeUrl && track && track !== activeTrack) {
          activeTrack = track;
          renderPanel(activeMeta, activeTrack);
        }
      } catch (_) {
        /* Track metadata is optional and often blocked by stream CORS policy. */
      } finally {
        trackController = null;

        if (url === activeUrl && activeTrack) {
          trackTimer = setTimeout(poll, TRACK_POLL_MS);
        }
      }
    };

    poll();
  }

  function setMeta(url, data) {
    if (!url || !data) return;
    const cache = _loadCache();
    cache[url] = {
      name:        data.name        || null,
      description: data.description || null,
      genre:       data.tags        || data.genre || null,
      url:         data.homepage    || data.url   || null,
      logo:        data.favicon     || data.logo  || null,
      bitrate:     data.bitrate     ? String(data.bitrate) : null,
      samplerate:  data.samplerate  || null,
      _cached_at:  Date.now(),
    };
    _saveCache(cache);
  }

  async function fetchMeta(url) {
    const cache = _loadCache();
    if (cache[url]) return cache[url];

    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal });
      clearTimeout(tid);
      try { if (res.body) await res.body.cancel(); } catch (_) {}
      const h = res.headers;
      const get = k => h.get(k) || h.get(k.toLowerCase()) || null;
      const meta = {
        name: get('icy-name'), description: get('icy-description'), genre: get('icy-genre'),
        url: get('icy-url'), logo: get('icy-logo'), bitrate: get('icy-br'), samplerate: get('icy-sr'),
        _cached_at: Date.now(),
      };
      const result = Object.values(meta).some((v, i, a) => i < a.length - 1 && v !== null) ? meta : null;
      if (result) {
        cache[url] = result;
        _saveCache(cache);
      }
      return result;
    } catch { return null; }
  }

  function renderPanel(meta, track = activeTrack) {
    if (!panelEl || (!meta && !track)) return;

    const displayMeta = meta || {};
    const stationName = displayMeta.name || _fallbackStationName();
    const nameHtml = displayMeta.url
      ? `<a href="${esc(displayMeta.url)}" target="_blank" rel="noopener">${esc(stationName)}</a>`
      : esc(stationName);
    const genreTags = displayMeta.genre
      ? displayMeta.genre.split(/[\s/]+/).filter(Boolean).map(g => `<span class="station-meta__tag">${esc(g)}</span>`).join('')
      : '';
    const techTags = [
      displayMeta.bitrate    ? `<span class="station-meta__tag station-meta__tag--hl">${esc(displayMeta.bitrate)} kbps</span>` : '',
      displayMeta.samplerate ? `<span class="station-meta__tag">${esc(displayMeta.samplerate)} Hz</span>` : '',
    ].join('');
    const logoHtml = displayMeta.logo
      ? `<img class="station-meta__logo" src="${esc(displayMeta.logo)}" alt="" onerror="this.outerHTML='<div class=station-meta__logo-placeholder>📻</div>'">`
      : `<div class="station-meta__logo-placeholder">📻</div>`;
    panelEl.innerHTML = `
      ${logoHtml}
      <div class="station-meta__info">
        <div class="station-meta__name">${nameHtml}</div>
        ${track ? `<div class="station-meta__track"><span class="station-meta__track-label">Now playing</span> ${esc(track)}</div>` : ''}
        ${displayMeta.description ? `<div class="station-meta__desc">${esc(displayMeta.description)}</div>` : ''}
        ${(genreTags || techTags) ? `<div class="station-meta__tags">${genreTags}${techTags}</div>` : ''}
      </div>`;
    panelEl.classList.add('is-visible');
  }

  async function load(url) {
    activeUrl = url;
    activeMeta = null;
    activeTrack = null;
    _startTrackUpdates(url);

    if (titleEl) titleEl.innerText = "radiocombinator.com";
    const meta = await fetchMeta(url);
    if (url !== activeUrl) return null;

    activeMeta = meta;
    if (meta && meta.name) titleEl.innerText = meta.name;
    renderPanel(activeMeta, activeTrack);
    return meta;
  }

  function clear() {
    activeUrl = null;
    activeMeta = null;
    activeTrack = null;
    _stopTrackUpdates();

    if (!panelEl) return;
    panelEl.innerHTML = '';
    panelEl.classList.remove('is-visible');
  }

  function clearCache() {
    localStorage.removeItem(STORAGE_KEY);
  }

  return { fetchMeta, renderPanel, load, clear, esc, setMeta, clearCache };
})();
