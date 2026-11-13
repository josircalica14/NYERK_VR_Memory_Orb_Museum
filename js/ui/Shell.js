/**
 * UI Shell
 * ---------
 * A DOM layer over the two Three.js scenes. It adds what the 3D views could
 * not express on their own without touching the renderers:
 *
 *   - onboarding hint + crosshair
 *   - HUD with progress, directory, memory list, sound and help
 *   - member directory and per-hall memory list (fully keyboard operable)
 *   - full-size memory viewer (this is the only way to actually read a memory)
 *   - deep links:  #/hall/<folder>  and  #/hall/<folder>/<cardKey>
 *   - visited state persisted in localStorage
 *
 * All media comes from js/media-manifest.js, so no request ever probes for a
 * file that does not exist. Thumbnails come from assets/thumbs/.
 *
 * Public events it listens to:  portfolioSelected, returnToMainMuseum
 * Globals it reads:             portfolioData, portfolioMedia, detailView,
 *                               museumController, audioManager
 */
(function () {
  'use strict';

  var LS_VISITED = 'retrowalk.visited.v1';
  var LS_SOUND = 'retrowalk.sound.v1';
  var LS_INTRO = 'retrowalk.introHidden.v1';
  var CARD_KEY = /^(overview|gallery|technologies|details|links|contact|placeholder\d+)$/;

  var state = {
    ready: false,
    hall: null, // folder of the open hall
    item: null, // portfolio item for the open hall
    cards: [], // [{ key, caption, media: [] }] for the open hall
    playlist: [], // [{ cardKey, caption, file }] flattened for the viewer
    playIndex: -1,
    visited: {},
    panel: null, // 'directory' | 'memories' | null
    viewerOpen: false,
    soundMuted: false,
    coarse: false
  };

  var el = {};

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  function items() {
    return Array.isArray(window.portfolioData) ? window.portfolioData : [];
  }

  function mediaMap() {
    return window.portfolioMedia || {};
  }

  function mediaFor(folder, card) {
    var folderMedia = mediaMap()[folder];
    var files = folderMedia && folderMedia[card];
    return Array.isArray(files) ? files : [];
  }

  function cardKeysFor(folder) {
    var cards = mediaMap()[folder] || {};
    return Object.keys(cards).filter(function (key) {
      return CARD_KEY.test(key) && cards[key].length;
    });
  }

  function isVideo(file) {
    return /\.(mp4|webm)$/i.test(file);
  }

  function thumbPath(folder, card, file) {
    return (
      'assets/thumbs/' + folder + '/' + card + '/' + String(file).replace(/\.[^.]+$/, '') + '.jpg'
    );
  }

  function mediaPath(folder, card, file) {
    return 'assets/portfolios/' + folder + '/' + card + '/' + file;
  }

  function avatarPath(folder) {
    return 'assets/thumbs/' + folder + '/_avatar.jpg';
  }

  function humanize(key) {
    var m = /^placeholder(\d+)$/.exec(key);
    if (m) return 'Memory ' + m[1];
    return key.charAt(0).toUpperCase() + key.slice(1);
  }

  function readJSON(storage, key, fallback) {
    try {
      var raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (err) {
      return fallback;
    }
  }

  function writeJSON(storage, key, value) {
    try {
      storage.setItem(key, JSON.stringify(value));
    } catch (err) {
      /* private mode / quota: progress is a nicety, never block on it */
    }
  }

  function waitFor(test, timeout, interval) {
    timeout = timeout || 12000;
    interval = interval || 150;
    return new Promise(function (resolve) {
      var started = Date.now();
      (function tick() {
        var value;
        try {
          value = test();
        } catch (err) {
          value = false;
        }
        if (value) return resolve(value);
        if (Date.now() - started > timeout) return resolve(false);
        setTimeout(tick, interval);
      })();
    });
  }

  function icon(name) {
    var paths = {
      grid:
        '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>' +
        '<rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
      list:
        '<path d="M4 6h16M4 12h16M4 18h10"/>',
      mouse:
        '<rect x="7" y="2.5" width="10" height="19" rx="5"/><path d="M12 7v4"/>',
      soundOn:
        '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 6a9 9 0 0 1 0 12"/>',
      soundOff:
        '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 5 6M21 9l-5 6"/>',
      help:
        '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .9-1 1.7v.3"/><path d="M12 17h.01"/>',
      close: '<path d="M6 6l12 12M18 6L6 18"/>',
      next: '<path d="m9 6 6 6-6 6"/>',
      prev: '<path d="m15 6-6 6 6 6"/>',
      play: '<path d="M8 5.5v13l11-6.5z"/>',
      back: '<path d="M15 6l-6 6 6 6"/>'
    };
    return (
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      (paths[name] || '') +
      '</svg>'
    );
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ------------------------------------------------------------------ *
   * DOM construction
   * ------------------------------------------------------------------ */

  function build() {
    var root = document.createElement('div');
    root.id = 'rw-shell';
    root.hidden = true;

    root.innerHTML =
      '<div class="rw-crosshair" aria-hidden="true"></div>' +
      '<div class="rw-live" role="status" aria-live="polite" aria-atomic="true"></div>' +
      '<div class="rw-hud" aria-label="Museum controls">' +
      '  <div class="rw-progress">' +
      '    <span class="rw-progress__label" data-progress-label>Halls</span>' +
      '    <span class="rw-progress__value" data-progress-value>0 / 0</span>' +
      '    <span class="rw-progress__bar" aria-hidden="true"><span class="rw-progress__fill" data-progress-fill></span></span>' +
      '  </div>' +
      '  <button type="button" class="rw-icon-btn" data-action="directory" aria-expanded="false" data-tip="Directory">' +
      icon('grid') +
      '    <span class="rw-icon-btn__label">Member directory</span>' +
      '  </button>' +
      '  <button type="button" class="rw-icon-btn" data-action="memories" aria-expanded="false" data-tip="Memories" hidden>' +
      icon('list') +
      '    <span class="rw-icon-btn__label">Memories in this hall</span>' +
      '  </button>' +
      '  <button type="button" class="rw-icon-btn" data-action="pointer" data-locked="false" aria-pressed="false" data-tip="Capture mouse (L)">' +
      icon('mouse') +
      '    <span class="rw-icon-btn__label">Capture the mouse pointer (L)</span>' +
      '  </button>' +
      '  <button type="button" class="rw-icon-btn" data-action="sound" data-muted="false" data-tip="Sound">' +
      '    <span class="rw-sound-on">' + icon('soundOn') + '</span>' +
      '    <span class="rw-sound-off">' + icon('soundOff') + '</span>' +
      '    <span class="rw-icon-btn__label">Toggle sound</span>' +
      '  </button>' +
      '  <button type="button" class="rw-icon-btn" data-action="help" data-tip="How to move">' +
      icon('help') +
      '    <span class="rw-icon-btn__label">Show controls</span>' +
      '  </button>' +
      '</div>' +
      '<div class="rw-hint" role="note">' +
      '  <p class="rw-hint__text" data-hint-text></p>' +
      '  <button type="button" class="rw-hint__close" data-action="dismiss-hint" aria-label="Dismiss controls hint">' +
      icon('close') +
      '  </button>' +
      '</div>' +
      '<section class="rw-panel" data-panel="directory" data-side="left" role="dialog" aria-modal="false" aria-labelledby="rw-directory-title">' +
      '  <header class="rw-panel__head">' +
      '    <div>' +
      '      <p class="rw-panel__eyebrow">NYERK</p>' +
      '      <h2 class="rw-panel__title" id="rw-directory-title">Memory halls</h2>' +
      '      <p class="rw-panel__sub" data-directory-sub></p>' +
      '    </div>' +
      '    <button type="button" class="rw-icon-btn" data-action="close-panel" aria-label="Close directory">' +
      icon('close') +
      '    </button>' +
      '  </header>' +
      '  <div class="rw-panel__body" data-directory-body></div>' +
      '</section>' +
      '<section class="rw-panel" data-panel="memories" data-side="right" role="dialog" aria-modal="false" aria-labelledby="rw-memories-title">' +
      '  <header class="rw-panel__head">' +
      '    <div>' +
      '      <p class="rw-panel__eyebrow" data-memories-eyebrow>Memories</p>' +
      '      <h2 class="rw-panel__title" id="rw-memories-title" data-memories-title>This hall</h2>' +
      '      <p class="rw-panel__sub" data-memories-sub></p>' +
      '    </div>' +
      '    <button type="button" class="rw-icon-btn" data-action="close-panel" aria-label="Close memory list">' +
      icon('close') +
      '    </button>' +
      '  </header>' +
      '  <div class="rw-panel__body" data-memories-body></div>' +
      '</section>' +
      '<div class="rw-intro" role="dialog" aria-modal="true" aria-labelledby="rw-intro-title" aria-describedby="rw-intro-sub">' +
      '  <div class="rw-intro__card">' +
      '    <p class="rw-intro__eyebrow">RetroWalk</p>' +
      '    <h2 class="rw-intro__title" id="rw-intro-title">How to move around</h2>' +
      '    <p class="rw-intro__sub" id="rw-intro-sub">A museum you walk through. Four things to know before you step in.</p>' +
      '    <div class="rw-intro__list">' +
      '      <div class="rw-intro__row"><span class="rw-intro__key">Walk</span><span class="rw-intro__value" data-intro-walk><span class="rw-kbd">W</span><span class="rw-kbd">A</span><span class="rw-kbd">S</span><span class="rw-kbd">D</span> or the arrow keys</span></div>' +
      '      <div class="rw-intro__row"><span class="rw-intro__key">Look</span><span class="rw-intro__value" data-intro-look>Drag with the mouse. For free look, press the <b>mouse button</b> in the top bar to capture the pointer \u2014 <span class="rw-kbd">Esc</span> releases it.</span></div>' +
      '      <div class="rw-intro__row"><span class="rw-intro__key">Open</span><span class="rw-intro__value">Click a glowing orb, or open the <b>Memories</b> list to read one properly.</span></div>' +
      '      <div class="rw-intro__row"><span class="rw-intro__key">Leave a hall</span><span class="rw-intro__value"><span class="rw-kbd">Esc</span> or the <b>Back</b> button</span></div>' +
      '    </div>' +
      '    <div class="rw-intro__foot">' +
      '      <label class="rw-check"><input type="checkbox" data-intro-check>' +
      '        <span class="rw-check__box" aria-hidden="true"></span>Don\u2019t show this again</label>' +
      '      <button type="button" class="rw-btn rw-btn--primary" data-action="start">Start exploring</button>' +
      '    </div>' +
      '    <p class="rw-intro__note">Reopen this any time with the question mark button.</p>' +
      '  </div>' +
      '</div>' +
      '<div class="rw-viewer" role="dialog" aria-modal="true" aria-labelledby="rw-viewer-title" tabindex="-1">' +
      '  <div class="rw-viewer__ambient" data-viewer-ambient aria-hidden="true"></div>' +
      '  <header class="rw-viewer__head">' +
      '    <div class="rw-viewer__heading">' +
      '      <p class="rw-viewer__crumb" data-viewer-crumb></p>' +
      '      <h2 class="rw-viewer__title" id="rw-viewer-title" data-viewer-title></h2>' +
      '      <p class="rw-viewer__meta" data-viewer-meta></p>' +
      '    </div>' +
      '    <button type="button" class="rw-icon-btn rw-viewer__close" data-action="close-viewer" aria-label="Close memory">' +
      icon('close') +
      '    </button>' +
      '  </header>' +
      '  <div class="rw-viewer__stage" data-viewer-stage data-state="empty"></div>' +
      '  <footer class="rw-viewer__foot">' +
      '    <div class="rw-viewer__strip" data-viewer-strip role="group" aria-label="Memories in this hall"></div>' +
      '    <div class="rw-viewer__bottom">' +
      '      <span class="rw-viewer__count" data-viewer-count></span>' +
      '      <span class="rw-viewer__keys" aria-hidden="true">' +
      '        <span class="rw-kbd">\u2190</span><span class="rw-kbd">\u2192</span> browse' +
      '        <span class="rw-kbd">Esc</span> close' +
      '      </span>' +
      '      <div class="rw-viewer__nav">' +
      '        <button type="button" class="rw-btn rw-btn--icon" data-action="prev" aria-label="Previous memory">' +
      icon('prev') +
      '        </button>' +
      '        <button type="button" class="rw-btn rw-btn--icon" data-action="next" aria-label="Next memory">' +
      icon('next') +
      '        </button>' +
      '      </div>' +
      '    </div>' +
      '  </footer>' +
      '</div>' +
      '<div class="rw-toast" data-toast></div>';

    document.body.appendChild(root);

    el.root = root;
    el.crosshair = root.querySelector('.rw-crosshair');
    el.live = root.querySelector('.rw-live');
    el.hud = root.querySelector('.rw-hud');
    el.hint = root.querySelector('.rw-hint');
    el.hintText = root.querySelector('[data-hint-text]');
    el.progressLabel = root.querySelector('[data-progress-label]');
    el.progressValue = root.querySelector('[data-progress-value]');
    el.progressFill = root.querySelector('[data-progress-fill]');
    el.memoriesBtn = root.querySelector('[data-action="memories"]');
    el.soundBtn = root.querySelector('[data-action="sound"]');
    el.panels = {
      directory: root.querySelector('[data-panel="directory"]'),
      memories: root.querySelector('[data-panel="memories"]')
    };
    el.directoryBody = root.querySelector('[data-directory-body]');
    el.directorySub = root.querySelector('[data-directory-sub]');
    el.memoriesBody = root.querySelector('[data-memories-body]');
    el.memoriesTitle = root.querySelector('[data-memories-title]');
    el.memoriesEyebrow = root.querySelector('[data-memories-eyebrow]');
    el.memoriesSub = root.querySelector('[data-memories-sub]');
    el.intro = root.querySelector('.rw-intro');
    el.introCheck = root.querySelector('[data-intro-check]');
    el.introWalk = root.querySelector('[data-intro-walk]');
    el.introLook = root.querySelector('[data-intro-look]');
    el.introStart = root.querySelector('[data-action="start"]');
    el.viewer = root.querySelector('.rw-viewer');
    el.viewerTitle = root.querySelector('[data-viewer-title]');
    el.viewerCrumb = root.querySelector('[data-viewer-crumb]');
    el.viewerMeta = root.querySelector('[data-viewer-meta]');
    el.viewerStage = root.querySelector('[data-viewer-stage]');
    el.viewerStrip = root.querySelector('[data-viewer-strip]');
    el.viewerAmbient = root.querySelector('[data-viewer-ambient]');
    el.viewerCount = root.querySelector('[data-viewer-count]');
    el.prevBtn = root.querySelector('[data-action="prev"]');
    el.nextBtn = root.querySelector('[data-action="next"]');
    el.toast = root.querySelector('[data-toast]');
  }

  /* ------------------------------------------------------------------ *
   * State helpers
   * ------------------------------------------------------------------ */

  function isHall(folder) {
    return state.hall === folder;
  }

  function hallCards(folder, item) {
    var available = cardKeysFor(folder);
    var seen = {};
    var cards = [];

    var orbs = (window.detailView && window.detailView.orbs) || [];
    orbs.forEach(function (orb) {
      var key = orb && orb.cardKey;
      if (!key || seen[key] || !CARD_KEY.test(key)) return;
      if (!mediaFor(folder, key).length) return;
      seen[key] = true;
      cards.push({
        key: key,
        caption: orb.caption || (item.cardTitles && item.cardTitles[key]) || humanize(key),
        media: mediaFor(folder, key)
      });
    });

    available.forEach(function (key) {
      if (seen[key]) return;
      seen[key] = true;
      cards.push({
        key: key,
        caption: (item.cardTitles && item.cardTitles[key]) || humanize(key),
        media: mediaFor(folder, key)
      });
    });

    return cards;
  }

  function markVisited(folder, cardKey) {
    if (!folder || !cardKey) return;
    state.visited[folder] = state.visited[folder] || {};
    if (state.visited[folder][cardKey]) return;
    state.visited[folder][cardKey] = Date.now();
    writeJSON(window.localStorage, LS_VISITED, state.visited);
    renderHud();
  }

  function visitedCount(folder) {
    return Object.keys(state.visited[folder] || {}).length;
  }

  function hallTotal(folder) {
    return cardKeysFor(folder).length;
  }

  function lobbyCounts() {
    var total = 0;
    var seen = 0;
    items().forEach(function (item) {
      total += 1;
      if (visitedCount(item.folder) > 0) seen += 1;
    });
    return { seen: seen, total: total };
  }

  function announce(message) {
    if (!el.live) return;
    el.live.textContent = '';
    window.setTimeout(function () {
      el.live.textContent = message;
    }, 30);
  }

  function toast(message) {
    if (!el.toast) return;
    el.toast.textContent = message;
    el.toast.classList.add('is-visible');
    window.clearTimeout(el.toast._timer);
    el.toast._timer = window.setTimeout(function () {
      el.toast.classList.remove('is-visible');
    }, 2600);
  }

  /* ------------------------------------------------------------------ *
   * HUD
   * ------------------------------------------------------------------ */

  function renderHud() {
    if (!el.root) return;
    var inHall = Boolean(state.hall);

    if (inHall) {
      var folder = state.hall;
      var total = state.cards.length || hallTotal(folder);
      var seen = state.cards.filter(function (card) {
        return (state.visited[folder] || {})[card.key];
      }).length;
      el.progressLabel.textContent = 'Memories';
      el.progressValue.textContent = seen + ' / ' + total;
      el.progressFill.style.width = (total ? (seen / total) * 100 : 0) + '%';
      if (el.memoriesBtn) el.memoriesBtn.hidden = false;
    } else {
      var counts = lobbyCounts();
      el.progressLabel.textContent = 'Halls';
      el.progressValue.textContent = counts.seen + ' / ' + counts.total;
      el.progressFill.style.width =
        (counts.total ? (counts.seen / counts.total) * 100 : 0) + '%';
      if (el.memoriesBtn) el.memoriesBtn.hidden = true;
      if (state.panel === 'memories') closePanel();
    }
  }

  function showHud() {
    el.hud.classList.add('is-visible');
    el.crosshair.classList.add('is-visible');
  }

  function hideHud() {
    el.hud.classList.remove('is-visible');
    el.crosshair.classList.remove('is-visible');
  }

  function hintCopy() {
    if (state.hall) {
      return state.coarse
        ? 'Tap <b>Memories</b> to open anything in this hall, or drag to look around.'
        : 'Drag to look, or press <span class="rw-kbd">L</span> to capture the mouse for free look. Press <span class="rw-kbd">Esc</span> or <b>Back</b> to return to the lobby.';
    }
    return state.coarse
      ? 'Tap the <b>grid</b> button to pick a member. Drag to look around.'
      : 'Walk with <span class="rw-kbd">W</span><span class="rw-kbd">A</span><span class="rw-kbd">S</span><span class="rw-kbd">D</span> or the arrow keys, drag to look, and press <span class="rw-kbd">L</span> to capture the mouse. The <b>grid</b> button lists every hall.';
  }

  function showHint(force) {
    if (!el.hint) return;
    el.hintText.innerHTML = hintCopy();
    el.hint.classList.add('is-visible');
    window.clearTimeout(showHint._timer);
    if (!force) {
      showHint._timer = window.setTimeout(function () {
        hideHint();
      }, 14000);
    }
  }

  function hideHint() {
    if (!el.hint) return;
    window.clearTimeout(showHint._timer);
    el.hint.classList.remove('is-visible');
  }

  /* ------------------------------------------------------------------ *
   * Intro / tutorial dialog
   * ------------------------------------------------------------------ */

  var INTRO_WALK =
    '<span class="rw-kbd">W</span><span class="rw-kbd">A</span><span class="rw-kbd">S</span>' +
    '<span class="rw-kbd">D</span> or the arrow keys';
  var INTRO_LOOK =
    'Drag with the mouse. For free look, press <span class="rw-kbd">L</span> or the ' +
    '<b>mouse button</b> in the top bar to capture the pointer \u2014 ' +
    '<span class="rw-kbd">Esc</span> releases it.';
  var INTRO_WALK_TOUCH =
    'Tap the <b>grid</b> button to pick a hall. The 3D halls are walkable with a mouse and keyboard.';
  var INTRO_LOOK_TOUCH =
    'Drag to look around. The <b>Memories</b> list opens every memory in a hall without walking.';

  function introHidden() {
    return readJSON(window.localStorage, LS_INTRO, false) === true;
  }

  function introIsOpen() {
    return Boolean(el.intro && el.intro.classList.contains('is-open'));
  }

  function openIntro() {
    if (!el.intro) return;
    if (isPointerLocked()) document.exitPointerLock();
    if (state.panel) closePanel();

    state._introReturn = document.activeElement;
    el.introCheck.checked = introHidden();
    el.introWalk.innerHTML = state.coarse ? INTRO_WALK_TOUCH : INTRO_WALK;
    el.introLook.innerHTML = state.coarse ? INTRO_LOOK_TOUCH : INTRO_LOOK;

    el.intro.classList.add('is-open');
    window.setTimeout(function () {
      if (el.introStart) el.introStart.focus({ preventScroll: true });
    }, 40);
    announce('How to move around. Four controls, then Start exploring.');
  }

  function closeIntro(save) {
    if (!el.intro) return;
    if (save) writeJSON(window.localStorage, LS_INTRO, el.introCheck.checked === true);
    el.intro.classList.remove('is-open');
    if (state._introReturn && state._introReturn.focus) {
      state._introReturn.focus({ preventScroll: true });
    }
    state._introReturn = null;
    showHint();
  }

  /* ------------------------------------------------------------------ *
   * Directory
   * ------------------------------------------------------------------ */

  function renderDirectory() {
    if (!el.directoryBody) return;
    var rows = [];
    var counts = lobbyCounts();
    el.directorySub.textContent =
      counts.seen + ' of ' + counts.total + ' halls explored. Pick a name to walk straight in.';

    if (state.hall) {
      rows.push(
        '<button type="button" class="rw-member" data-lobby="1">' +
          '<span class="rw-avatar" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24" style="width:20px;height:20px;margin:12px;">' +
          icon('back') +
          '</svg></span>' +
          '<span><span class="rw-member__name">Back to the lobby</span>' +
          '<span class="rw-member__meta">Leave this hall</span></span>' +
          '<span class="rw-member__count">Esc</span>' +
          '</button>'
      );
    }

    items().forEach(function (item) {
      var total = hallTotal(item.folder);
      var seen = visitedCount(item.folder);
      var done = total && seen >= total;
      rows.push(
        '<button type="button" class="rw-member" data-folder="' +
          esc(item.folder) +
          '"' +
          (isHall(item.folder) ? ' aria-current="true"' : '') +
          '>' +
          '<span class="rw-avatar"><span class="rw-avatar__initial" aria-hidden="true">' +
          esc(String(item.title || '?').charAt(0).toUpperCase()) +
          '</span><img src="' +
          avatarPath(item.folder) +
          '" alt="" width="44" height="44" loading="lazy" decoding="async" ' +
          'onerror="this.remove()"></span>' +
          '<span><span class="rw-member__name">' +
          esc(item.title) +
          '</span><span class="rw-member__meta">' +
          (total ? total + ' memories' : 'empty hall') +
          '</span></span>' +
          '<span class="rw-member__count' +
          (done ? ' is-done' : '') +
          '">' +
          (total ? seen + '/' + total : '—') +
          '</span>' +
          '</button>'
      );
    });

    el.directoryBody.innerHTML = rows.join('');
  }

  /* ------------------------------------------------------------------ *
   * Memory list
   * ------------------------------------------------------------------ */

  function renderMemories() {
    if (!el.memoriesBody) return;
    var item = state.item;
    if (!item) return;

    el.memoriesEyebrow.textContent = 'Memory hall';
    el.memoriesTitle.textContent = item.title;
    el.memoriesSub.textContent = state.cards.length + ' memories in this hall';

    if (!state.cards.length) {
      el.memoriesBody.innerHTML =
        '<p class="rw-empty">This hall has no media yet.<br>Add files under ' +
        '<code>assets/portfolios/' +
        esc(item.folder) +
        '/</code>, then run <code>python tools/build-media.py</code>.</p>';
      return;
    }

    var rows = state.cards.map(function (card) {
      var first = card.media[0];
      var thumbInner = isVideo(first)
        ? icon('play')
        : '<img src="' + thumbPath(item.folder, card.key, first) + '" alt="" width="56" height="42" loading="lazy" decoding="async">';
      var seen = (state.visited[item.folder] || {})[card.key];
      var count = card.media.length;
      return (
        '<button type="button" class="rw-memory" data-card="' +
        esc(card.key) +
        '">' +
        '<span class="rw-thumb">' +
        thumbInner +
        '</span>' +
        '<span><span class="rw-memory__caption">' +
        esc(card.caption) +
        '</span><span class="rw-memory__meta">' +
        count +
        (count === 1 ? ' item' : ' items') +
        (isVideo(first) ? ' · video' : '') +
        '</span></span>' +
        '<span class="rw-memory__seen' +
        (seen ? ' is-seen' : '') +
        '" aria-hidden="true"></span>' +
        '</button>'
      );
    });

    el.memoriesBody.innerHTML = rows.join('');
  }

  /* ------------------------------------------------------------------ *
   * Panels
   * ------------------------------------------------------------------ */

  function openPanel(name) {
    if (!el.panels[name]) return;
    if (state.viewerOpen) closeViewer();
    if (isPointerLocked()) document.exitPointerLock();
    if (state.panel && state.panel !== name) closePanel();

    state.panel = name;
    if (name === 'directory') renderDirectory();
    if (name === 'memories') renderMemories();

    el.panels[name].classList.add('is-open');
    var trigger = el.root.querySelector('[data-action="' + name + '"]');
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
    el.crosshair.classList.remove('is-visible');

    var first = el.panels[name].querySelector('.rw-member, .rw-memory');
    if (first) first.focus({ preventScroll: true });
  }

  function closePanel() {
    if (!state.panel) return;
    var panel = el.panels[state.panel];
    if (panel) panel.classList.remove('is-open');
    var trigger = el.root.querySelector('[data-action="' + state.panel + '"]');
    if (trigger) {
      trigger.setAttribute('aria-expanded', 'false');
      if (trigger.focus) trigger.focus({ preventScroll: true });
    }
    state.panel = null;
    if (!state.viewerOpen) el.crosshair.classList.add('is-visible');
  }

  function closeLayers() {
    if (state.viewerOpen) closeViewer();
    if (state.panel) closePanel();
  }

  /* ------------------------------------------------------------------ *
   * Viewer
   * ------------------------------------------------------------------ */

  function buildPlaylist() {
    var item = state.item;
    var list = [];
    state.cards.forEach(function (card) {
      card.media.forEach(function (file, index) {
        list.push({
          cardKey: card.key,
          caption: card.caption,
          file: file,
          indexInCard: index,
          cardSize: card.media.length
        });
      });
    });
    state.playlist = list;
  }

  function openCard(cardKey, options) {
    buildPlaylist();
    var index = state.playlist.findIndex(function (entry) {
      return entry.cardKey === cardKey;
    });
    if (index < 0) {
      toast('No media in that memory yet');
      return;
    }
    openPlaylistIndex(index, options);
  }

  function openPlaylistIndex(index, options) {
    options = options || {};
    if (!state.playlist.length) return;
    state.playIndex = Math.max(0, Math.min(index, state.playlist.length - 1));
    var entry = state.playlist[state.playIndex];
    var item = state.item;
    if (!entry || !item) return;

    // A captured cursor cannot reach the viewer's own buttons.
    if (isPointerLocked()) document.exitPointerLock();

    // Remember whether the list sent us here, so closing the memory returns
    // the visitor to the list instead of stranding them in the corridor.
    var wasOpen = state.viewerOpen;
    state._viewerFromPanel = Boolean(state.panel);
    if (state.panel) closePanel();
    state.viewerOpen = true;
    el.viewer.classList.add('is-open');
    el.crosshair.classList.remove('is-visible');

    if (!wasOpen) {
      // Send focus back to whatever opened the viewer when it closes.
      state._viewerReturn = document.activeElement;
      el.viewer.focus({ preventScroll: true });
    }

    el.viewerCrumb.textContent = item.title;
    el.viewerTitle.textContent = entry.caption;
    el.viewerMeta.textContent =
      (isVideo(entry.file) ? 'Video' : 'Photo') +
      (entry.cardSize > 1 ? ' ' + (entry.indexInCard + 1) + ' of ' + entry.cardSize : '');

    if (state._stripFor !== item.folder) renderStrip();
    syncStrip(entry.cardKey);
    renderMedia(item, entry);

    markVisited(item.folder, entry.cardKey);

    var cardVisited = state.cards.filter(function (card) {
      return (state.visited[item.folder] || {})[card.key];
    }).length;
    el.viewerCount.textContent =
      'Memory ' +
      (state.playIndex + 1) +
      ' of ' +
      state.playlist.length +
      ' \u00b7 ' +
      cardVisited +
      ' of ' +
      state.cards.length +
      ' memories seen';

    el.prevBtn.disabled = state.playIndex === 0;
    el.nextBtn.disabled = state.playIndex >= state.playlist.length - 1;

    announce('Now viewing ' + entry.caption);
    // Pushing is opt-in: a click in the list earns a history entry, while
    // stepping with arrows or landing from a deep link must not fill the back
    // button with one entry per memory.
    setHash(hallHash(item.folder, entry.cardKey), !options.push);
  }

  /** Thumbnail for a playlist entry; keeps a still frame for clips. */
  function entryThumb(item, entry) {
    if (!isVideo(entry.file)) return thumbPath(item.folder, entry.cardKey, entry.file);
    var card = state.cards.filter(function (candidate) {
      return candidate.key === entry.cardKey;
    })[0];
    var still = card && card.media.filter(function (file) { return !isVideo(file); })[0];
    return still ? thumbPath(item.folder, entry.cardKey, still) : '';
  }

  /** The strip lists one tile per memory, so a long hall stays one click away. */
  function renderStrip() {
    if (!el.viewerStrip || !state.item) return;
    var item = state.item;

    el.viewerStrip.innerHTML = state.cards
      .map(function (card) {
        var first = card.media[0];
        var clip = isVideo(first);
        var inner = clip
          ? icon('play')
          : '<img src="' +
            thumbPath(item.folder, card.key, first) +
            '" alt="" loading="lazy" decoding="async">';
        return (
          '<button type="button" class="rw-strip__item' +
          (clip ? ' is-video' : '') +
          '" data-strip="' +
          esc(card.key) +
          '" aria-label="' +
          esc(card.caption) +
          '" title="' +
          esc(card.caption) +
          '">' +
          inner +
          '</button>'
        );
      })
      .join('');

    state._stripFor = item.folder;
  }

  function syncStrip(activeKey) {
    if (!el.viewerStrip) return;
    Array.prototype.forEach.call(el.viewerStrip.children, function (button) {
      var active = button.getAttribute('data-strip') === activeKey;
      button.classList.toggle('is-active', active);
      if (active) {
        button.setAttribute('aria-current', 'true');
        if (button.scrollIntoView) {
          button.scrollIntoView({ block: 'nearest', inline: 'center' });
        }
      } else {
        button.removeAttribute('aria-current');
      }
    });
  }

  /**
   * Swap the stage to this entry. The stage stays in one of three states -
   * loading, ready, error - so the visitor always sees something deliberate
   * instead of an empty rectangle.
   */
  function renderMedia(item, entry) {
    var stage = el.viewerStage;
    var src = mediaPath(item.folder, entry.cardKey, entry.file);
    var thumb = entryThumb(item, entry);

    stage.dataset.state = 'loading';
    stage.classList.remove('is-zoomed');
    el.viewerAmbient.style.backgroundImage = thumb ? 'url("' + thumb + '")' : 'none';

    function ready() {
      if (stage.dataset.state !== 'error') stage.dataset.state = 'ready';
    }

    function failed() {
      stage.dataset.state = 'error';
      stage.innerHTML =
        '<div class="rw-viewer__error">' +
        '<p class="rw-viewer__error-title">This memory would not open</p>' +
        '<p class="rw-viewer__error-body">The file is listed in the manifest, but the browser could not read it. The original may still work.</p>' +
        '<a class="rw-btn" href="' +
        src +
        '" target="_blank" rel="noopener">Open original file</a>' +
        '</div>';
    }

    if (isVideo(entry.file)) {
      stage.innerHTML =
        '<video class="rw-viewer__media" src="' +
        src +
        '"' +
        (thumb ? ' poster="' + thumb + '"' : '') +
        ' controls autoplay playsinline preload="metadata"></video>';

      var video = stage.querySelector('video');
      video.addEventListener('loadeddata', ready);
      video.addEventListener('error', failed);
      video.play().catch(function () {
        // Autoplay refused: the poster and native controls carry the state.
        ready();
      });

      pauseMusicFor(entry.file);
    } else {
      var img = new Image();
      img.className = 'rw-viewer__media';
      img.alt = entry.caption;
      img.decoding = 'async';
      img.addEventListener('load', ready);
      img.addEventListener('error', failed);
      img.src = src;

      stage.innerHTML = '';
      stage.appendChild(img);
      if (img.complete && img.naturalWidth) ready();

      resumeMusicAfter();
    }

    prefetchNeighbours(item);
  }

  /** Warm the neighbours so stepping through a hall feels instant. */
  function prefetchNeighbours(item) {
    [-1, 1].forEach(function (delta) {
      var neighbour = state.playlist[state.playIndex + delta];
      if (!neighbour || isVideo(neighbour.file)) return;
      var img = new Image();
      img.src = mediaPath(item.folder, neighbour.cardKey, neighbour.file);
    });
  }

  function step(delta) {
    if (!state.viewerOpen) return;
    var next = state.playIndex + delta;
    if (next < 0 || next >= state.playlist.length) return;
    openPlaylistIndex(next);
  }

  function closeViewer() {
    if (!state.viewerOpen) return;
    state.viewerOpen = false;
    el.viewer.classList.remove('is-open');
    el.viewerStage.innerHTML = '';
    el.viewerStage.dataset.state = 'empty';
    el.viewerStage.classList.remove('is-zoomed');
    el.viewerAmbient.style.backgroundImage = 'none';
    state._stripFor = null;
    el.crosshair.classList.add('is-visible');
    resumeMusicAfter();
    if (state._viewerReturn && state._viewerReturn.focus) {
      state._viewerReturn.focus({ preventScroll: true });
    }
    state._viewerReturn = null;
    if (state.hall) setHash(hallHash(state.hall));
    if (state._viewerFromPanel && state.hall) {
      state._viewerFromPanel = false;
      openPanel('memories');
    }
  }

  function pauseMusicFor() {
    var am = window.audioManager;
    if (!am || state.soundMuted) return;
    if (am.bgMusic && !am.bgMusic.paused) {
      am.pause();
      state._musicPausedByViewer = true;
    }
  }

  function resumeMusicAfter() {
    if (!state._musicPausedByViewer) return;
    state._musicPausedByViewer = false;
    var am = window.audioManager;
    if (am && !state.soundMuted) am.resume();
  }

  /* ------------------------------------------------------------------ *
   * Routing
   * ------------------------------------------------------------------ */

  function hallHash(folder, cardKey) {
    return '#/hall/' + encodeURIComponent(folder) + (cardKey ? '/' + encodeURIComponent(cardKey) : '');
  }

  function setHash(hash, replace) {
    if (window.location.hash === hash) return;
    try {
      if (replace) window.history.replaceState(null, '', hash);
      else window.history.pushState(null, '', hash);
    } catch (err) {
      window.location.hash = hash;
    }
  }

  function parseHash() {
    var raw = window.location.hash.replace(/^#/, '');
    var match = /^\/hall\/([^/]+)(?:\/([^/]+))?$/.exec(raw);
    if (!match) return null;
    return { folder: decodeURIComponent(match[1]), cardKey: match[2] ? decodeURIComponent(match[2]) : null };
  }

  function applyRoute() {
    var route = parseHash();
    if (!route) {
      if (state.hall) closeHall({ fromRoute: true });
      return;
    }
    if (route.folder === state.hall) {
      if (route.cardKey) {
        var exists = state.playlist.some(function (entry) {
          return entry.cardKey === route.cardKey;
        });
        if (!exists) buildPlaylist();
        if (!state.viewerOpen) openCard(route.cardKey, { push: false });
      } else if (state.viewerOpen) {
        closeViewer();
      }
      return;
    }
    openHall(route.folder, route.cardKey, { fromRoute: true });
  }

  /* ------------------------------------------------------------------ *
   * Hall open / close
   * ------------------------------------------------------------------ */

  async function ensureMuseum() {
    var welcome = document.getElementById('welcome-screen');
    var btn = document.getElementById('enter-btn');

    if (welcome && !welcome.classList.contains('hidden')) {
      // Shell.js is registered before the page's own DOMContentLoaded handler,
      // so a deep link can try to click Enter before that handler exists.
      // Wait for the load event, then click, then retry once.
      if (document.readyState !== 'complete') {
        await new Promise(function (resolve) {
          window.addEventListener('load', resolve, { once: true });
        });
      }
      if (btn) btn.click();
      await waitFor(function () {
        return welcome.classList.contains('hidden');
      }, 1200, 100);
      if (!welcome.classList.contains('hidden') && btn) btn.click();
    }

    await waitFor(function () {
      return window.museumController && window.museumController.threejsMuseum;
    }, 20000);
  }

  async function openHall(folder, cardKey, options) {
    options = options || {};
    var item = items().find(function (entry) {
      return entry.folder === folder;
    });
    if (!item) {
      toast('That hall does not exist');
      setHash('#/');
      return;
    }
    if (state.hall === folder) {
      if (cardKey) openCard(cardKey);
      return;
    }

    await ensureMuseum();

    state.hall = folder;
    state.item = item;
    state.cards = [];
    state.playlist = [];
    state.playIndex = -1;

    hideHint(false);
    closeLayers();
    renderHud();
    showHint();

    window.dispatchEvent(new CustomEvent('portfolioSelected', { detail: item }));

    await waitFor(function () {
      var view = window.detailView;
      return (
        view &&
        view.isActive &&
        view.portfolioData &&
        view.portfolioData.folder === folder &&
        Array.isArray(view.orbs) &&
        view.orbs.length > 0
      );
    }, 20000);

    state.cards = hallCards(folder, item);
    buildPlaylist();
    renderHud();
    renderMemories();

    if (!options.fromRoute) setHash(hallHash(folder, cardKey || null));
    if (cardKey) {
      openCard(cardKey);
    } else if (state.coarse) {
      openPanel('memories');
    }

    announce('Entered ' + item.title + '. ' + state.cards.length + ' memories.');
  }

  function closeHall(options) {
    options = options || {};
    state.hall = null;
    state.item = null;
    state.cards = [];
    state.playlist = [];
    state.playIndex = -1;
    closeLayers();
    renderHud();
    showHint();
    if (!options.fromRoute) {
      try {
        window.history.replaceState(null, '', '#/');
      } catch (err) {
        window.location.hash = '#/';
      }
    }
    announce('Back in the lobby.');
  }

  function leaveHall() {
    var view = window.detailView;
    if (view && typeof view.hide === 'function') view.hide();
    else closeHall();
  }

  /* ------------------------------------------------------------------ *
   * Pointer lock (optional mouse capture)
   * ------------------------------------------------------------------ */

  function isPointerLocked() {
    return document.pointerLockElement != null;
  }

  function activeCanvas() {
    if (state.hall && window.detailView && window.detailView.renderer) {
      return window.detailView.renderer.domElement;
    }
    var museum = window.museumController && window.museumController.threejsMuseum;
    if (museum && museum.renderer) return museum.renderer.domElement;
    return document.querySelector('#museum-space canvas') || document.querySelector('canvas');
  }

  function renderLockUi() {
    var locked = isPointerLocked();
    var btn = el.root && el.root.querySelector('[data-action="pointer"]');
    if (btn) {
      btn.setAttribute('data-locked', String(locked));
      btn.setAttribute('aria-pressed', String(locked));
      btn.setAttribute('data-tip', locked ? 'Release mouse (Esc)' : 'Capture mouse (L)');
    }
    if (el.root) el.root.classList.toggle('rw-locked', locked);
  }

  function togglePointerLock() {
    if (isPointerLocked()) {
      document.exitPointerLock();
      return;
    }
    var canvas = activeCanvas();
    if (!canvas || !canvas.requestPointerLock) {
      toast('This browser cannot capture the mouse');
      return;
    }
    // Plain requestPointerLock() is supported everywhere. The
    // unadjustedMovement variant is Chrome-only and rejecting it loses the
    // user gesture needed to retry, so never ask for it first.
    try {
      var result = canvas.requestPointerLock();
      if (result && typeof result.catch === 'function') {
        result.catch(function () {
          toast('Could not capture the mouse');
        });
      }
    } catch (err) {
      toast('Could not capture the mouse');
    }
  }

  /* ------------------------------------------------------------------ *
   * Sound
   * ------------------------------------------------------------------ */

  function applySound() {
    var am = window.audioManager;
    state.soundMuted = Boolean(readJSON(window.localStorage, LS_SOUND, false));
    if (el.soundBtn) el.soundBtn.setAttribute('data-muted', String(state.soundMuted));
    if (am && state.soundMuted) am.pause();
  }

  function toggleSound() {
    var am = window.audioManager;
    state.soundMuted = !state.soundMuted;
    writeJSON(window.localStorage, LS_SOUND, state.soundMuted);
    if (el.soundBtn) el.soundBtn.setAttribute('data-muted', String(state.soundMuted));
    if (am) {
      if (state.soundMuted) am.pause();
      else am.resume();
    }
    toast(state.soundMuted ? 'Sound off' : 'Sound on');
  }

  /* ------------------------------------------------------------------ *
   * Events
   * ------------------------------------------------------------------ */

  function wire() {
    el.root.addEventListener('click', function (event) {
      var actionEl = event.target.closest('[data-action]');
      if (actionEl) {
        var action = actionEl.getAttribute('data-action');
        if (action === 'directory' || action === 'memories') {
          if (state.panel === action) closePanel();
          else openPanel(action);
          return;
        }
        if (action === 'sound') return toggleSound();
        if (action === 'pointer') return togglePointerLock();
        if (action === 'help') return openIntro();
        if (action === 'start') return closeIntro(true);
        if (action === 'dismiss-hint') return hideHint();
        if (action === 'close-panel') return closePanel();
        if (action === 'close-viewer') return closeViewer();
        if (action === 'prev') return step(-1);
        if (action === 'next') return step(1);
      }

      var stripItem = event.target.closest('[data-strip]');
      if (stripItem) {
        openCard(stripItem.getAttribute('data-strip'), { push: true });
        return;
      }

      // Clicking the photo itself toggles between fit and actual size, which is
      // how you read text inside a screenshot.
      if (
        state.viewerOpen &&
        !state._swipedAt &&
        event.target.classList.contains('rw-viewer__media') &&
        state.playlist[state.playIndex] &&
        !isVideo(state.playlist[state.playIndex].file)
      ) {
        el.viewerStage.classList.toggle('is-zoomed');
        return;
      }

      var member = event.target.closest('[data-folder]');
      if (member) {
        var folder = member.getAttribute('data-folder');
        closePanel();
        if (state.hall && state.hall !== folder) {
          // Leaving straight from another hall: close it first so both
          // renderers do not argue over the same scene.
          leaveHall();
          window.setTimeout(function () {
            openHall(folder);
          }, 1100);
        } else {
          openHall(folder);
        }
        return;
      }

      if (event.target.closest('[data-lobby]')) {
        closePanel();
        leaveHall();
        return;
      }

      var memoryRow = event.target.closest('[data-card]');
      if (memoryRow) {
        openCard(memoryRow.getAttribute('data-card'), { push: true });
        return;
      }

      if (event.target === el.viewer) closeViewer();
    });

    // Capture phase, so the viewer owns Escape and the arrow keys instead of
    // the hall's camera and its own escape handler also reacting.
    document.addEventListener(
      'keydown',
      function (event) {
        if (introIsOpen()) {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeIntro(true);
            return;
          }
          if (event.key === 'Tab') {
            // Two stops only: keep focus inside the dialog.
            var stops = [el.introCheck, el.introStart];
            var index = stops.indexOf(document.activeElement);
            var next = event.shiftKey ? index - 1 : index + 1;
            if (index === -1) next = 0;
            if (next < 0) next = stops.length - 1;
            if (next >= stops.length) next = 0;
            event.preventDefault();
            stops[next].focus();
            return;
          }
        }

        if (state.viewerOpen) {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeViewer();
            return;
          }
          if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            event.preventDefault();
            event.stopPropagation();
            step(event.key === 'ArrowRight' ? 1 : -1);
            return;
          }
          if (event.key === 'Tab') {
            // Keep tabbing inside the dialog while it owns the screen.
            var stops = el.viewer.querySelectorAll(
              'button:not(:disabled), video[controls], a[href]'
            );
            if (stops.length) {
              var first = stops[0];
              var last = stops[stops.length - 1];
              var active = document.activeElement;
              if (event.shiftKey && (active === first || active === el.viewer)) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && active === last) {
                event.preventDefault();
                first.focus();
              }
            }
          }
        }
        // Esc is also how the browser releases a captured pointer. Swallow the
        // first one right after an unlock so releasing the mouse does not also
        // throw the visitor out of the hall.
        if (
          event.key === 'Escape' &&
          state._justUnlockedAt &&
          Date.now() - state._justUnlockedAt < 350
        ) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }

        // L toggles mouse capture. Deliberately not WASD-adjacent in meaning,
        // and unused by either scene's movement keys.
        if (
          event.code === 'KeyL' &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          !introIsOpen() &&
          !state.viewerOpen &&
          !state.panel &&
          (document.activeElement === document.body ||
            !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName))
        ) {
          event.preventDefault();
          togglePointerLock();
          return;
        }

        if (event.key === 'Escape' && state.panel) {
          event.preventDefault();
          event.stopPropagation();
          closePanel();
        }
      },
      true
    );

    // Swipe left/right on touch to step through the hall. The flag suppresses
    // the click-to-zoom that would otherwise fire at the end of a swipe.
    if (el.viewerStage) {
      var swipe = null;

      el.viewerStage.addEventListener('pointerdown', function (event) {
        swipe = { x: event.clientX, y: event.clientY };
      });

      el.viewerStage.addEventListener('pointerup', function (event) {
        if (!swipe) return;
        var dx = event.clientX - swipe.x;
        var dy = event.clientY - swipe.y;
        swipe = null;
        if (Math.abs(dx) > 60 && Math.abs(dy) < 50) {
          state._swipedAt = true;
          window.setTimeout(function () {
            state._swipedAt = false;
          }, 350);
          step(dx < 0 ? 1 : -1);
        }
      });

      el.viewerStage.addEventListener('pointercancel', function () {
        swipe = null;
      });
    }

    // Dismiss the hint the moment the visitor actually starts moving.
    ['keydown', 'pointerdown'].forEach(function (type) {
      document.addEventListener(
        type,
        function (event) {
          if (!el.root || el.root.hidden) return;
          if (el.root.contains(event.target)) return;
          if (el.hint && el.hint.classList.contains('is-visible')) hideHint(true);
        },
        { passive: true }
      );
    });

    window.addEventListener('portfolioSelected', function (event) {
      var item = event.detail;
      if (!item || !item.folder) return;
      // Opened from the 3D scene rather than the shell.
      if (state.hall === item.folder) return;
      state.hall = item.folder;
      state.item = item;
      state.cards = [];
      state.playlist = [];
      state.playIndex = -1;
      renderHud();
      showHint();
      setHash(hallHash(item.folder));
      waitFor(function () {
        var view = window.detailView;
        return view && view.isActive && view.portfolioData && view.portfolioData.folder === item.folder;
      }, 20000).then(function () {
        state.cards = hallCards(item.folder, item);
        buildPlaylist();
        renderHud();
        renderMemories();
        if (state.coarse) openPanel('memories');
      });
    });

    window.addEventListener('returnToMainMuseum', function () {
      if (!state.hall) return;
      closeHall();
    });

    document.addEventListener('pointerlockchange', function () {
      renderLockUi();
      if (isPointerLocked()) {
        toast('Mouse captured \u2014 press Esc to release');
      } else {
        state._justUnlockedAt = Date.now();
      }
    });

    document.addEventListener('pointerlockerror', function () {
      renderLockUi();
      toast('Could not capture the mouse');
    });

    window.addEventListener('popstate', applyRoute);

    window.addEventListener('resize', function () {
      state.coarse = window.matchMedia('(pointer: coarse)').matches;
    });

    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    var applyReduce = function () {
      el.root.classList.toggle('rw-reduced', reduce.matches);
    };
    applyReduce();
    if (reduce.addEventListener) reduce.addEventListener('change', applyReduce);
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  function reveal() {
    if (state.ready) return;
    state.ready = true;
    el.root.hidden = false;
    showHud();
    renderHud();

    // If the shell happens to mount before config.js has published the data
    // (slow first paint), render the counts again once it is there.
    if (!items().length) {
      window.setTimeout(function () {
        if (items().length) renderHud();
      }, 600);
    }

    // The controls hint greets every visit; the tutorial only appears until the
    // visitor ticks "Don't show this again".
    showHint();
    if (!introHidden()) openIntro();

    applyRoute();
  }

  function watchWelcome() {
    var welcome = document.getElementById('welcome-screen');
    if (!welcome) return reveal();

    if (welcome.classList.contains('hidden')) {
      window.setTimeout(reveal, 400);
      return;
    }

    var observer = new MutationObserver(function () {
      if (welcome.classList.contains('hidden')) {
        observer.disconnect();
        window.setTimeout(reveal, 400);
      }
    });
    observer.observe(welcome, { attributes: true, attributeFilter: ['class'] });
  }

  function init() {
    state.visited = readJSON(window.localStorage, LS_VISITED, {}) || {};
    state.coarse = window.matchMedia('(pointer: coarse)').matches;

    build();
    wire();
    applySound();
    renderLockUi();
    applyRouteOnLoad();
    watchWelcome();
  }

  function applyRouteOnLoad() {
    var route = parseHash();
    if (!route) return;
    // Deep link: enter without waiting for the visitor to click Enter.
    ensureMuseum().then(function () {
      openHall(route.folder, route.cardKey, { fromRoute: true });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
