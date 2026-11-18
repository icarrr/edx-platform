/*
 * Embedded audio player for capa problems.
 *
 * capa renders <audio src="..." allow-repeat="N" title="..." controls="false"/> from the problem XML into a
 * `.capa-audio` container (see capa.customrender.AudioRenderer). This script turns that markup into a
 * player laid out like the bunnynet-audio player: play/pause, skip back/forward and a seek bar (unlimited
 * replays only), current time and duration, mute/volume, playback speed, and a replay limit. It is started
 * from Problem.prototype.bind in display.js, which runs after every render of the problem (first load,
 * submit, reset, ...).
 *
 * Replay rules:
 *   - a "play" is starting playback from the beginning (or again after it ended);
 *   - pausing and resuming, or seeking inside the current play, does not count;
 *   - allow-repeat="N" allows N + 1 plays; omitted means unlimited;
 *   - once the last allowed play has ended, the play button is disabled.
 *
 * The play counter is learner state on the server (ProblemBlock.audio_plays). Every render of the problem
 * carries it in `data-audio-state` (lms/templates/problem.html); a new play is reported to the `audio_play`
 * handler, which enforces the limit from the problem XML and answers with the authoritative state. Playback
 * starts before the server answers (waiting would lose the click's user activation, and Safari would block
 * play()), and is paused if the server refuses. The resume position is kept only in localStorage (in memory
 * when storage is unavailable), keyed by problem, audio ordinal and source. Problem reset clears both.
 *
 * HLS playlists (.m3u8, e.g. Bunny Stream) play natively where the browser supports HLS (Safari, iOS, Android).
 * Elsewhere the player loads hls.js, the copy the video player already uses (RequireJS module 'hls', file
 * common/js/vendor/hls.js), only when such a source is present.
 *
 * This is a learning-experience control, not a security boundary: the audio URL is in the page, and when the
 * server cannot be reached the player keeps going on its local counters.
 */
(function() {
    'use strict';

    var root = this;
    var STORAGE_PREFIX = 'capa-audio:';
    var SAVE_INTERVAL_MS = 1000;
    var DEFAULT_SKIP_SECONDS = 10;
    var EXTENSION_TYPES = {
        mp3: 'audio/mpeg',
        wav: 'audio/wav',
        ogg: 'audio/ogg',
        oga: 'audio/ogg',
        opus: 'audio/ogg; codecs="opus"',
        m4a: 'audio/mp4',
        mp4: 'audio/mp4',
        aac: 'audio/aac',
        webm: 'audio/webm',
        flac: 'audio/flac',
        m3u8: 'application/vnd.apple.mpegurl'
    };
    var HLS_TYPE = 'application/vnd.apple.mpegurl';
    var HLS_SCRIPT_URL = '/static/common/js/vendor/hls.js';
    var memoryStore = {};
    var livePlayers = [];
    var hlsWaiting = null;
    // Replaceable hls.js loader (the specs stub it).
    var hlsLoader = {load: function(done) { loadHls(done); }};

    function t(text) {
        return typeof root.gettext === 'function' ? root.gettext(text) : text;
    }

    /** Log a problem that leaves the play counters out of sync with the server. */
    function warn() {
        if (root.console && typeof root.console.warn === 'function') {
            root.console.warn.apply(root.console, ['[CapaAudio]'].concat(Array.prototype.slice.call(arguments)));
        }
    }

    function format(text, values) {
        if (typeof root.interpolate === 'function') {
            return root.interpolate(text, values, true);
        }
        return text.replace(/%\((\w+)\)s/g, function(match, name) {
            return values[name];
        });
    }

    function mediaErrorText(code) {
        switch (code) {
        case 1: return t('Audio loading was interrupted.');
        case 2: return t('A network error stopped the audio from loading.');
        case 3: return t('The audio file could not be decoded.');
        case 4: return t('The audio file could not be found, or its format is not supported by your browser.');
        default: return t('The audio could not be played.');
        }
    }

    /* ------------------------------------------------------------------ pure helpers (tested directly) */

    /** Number of additional plays allowed, or null for unlimited. */
    function parseLimit(value) {
        var text = value === null || value === undefined ? '' : String(value).trim();
        return /^\d+$/.test(text) ? parseInt(text, 10) : null;
    }

    /**
     * Derive what the player may do from its saved counters.
     * plays: plays started so far (including the current one); ended: whether the current play finished.
     */
    function replayState(limit, plays, ended) {
        var allowed = limit === null ? Infinity : limit + 1;
        var canStartNew = plays < allowed;
        return {
            canStartNew: canStartNew,
            locked: plays > 0 && ended && !canStartNew,
            remaining: limit === null ? null : Math.max(0, limit - Math.max(0, plays - 1))
        };
    }

    function formatTime(seconds) {
        var total = isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
        var hours = Math.floor(total / 3600);
        var minutes = Math.floor((total % 3600) / 60);
        var secs = total % 60;
        var minutesText = hours && minutes < 10 ? '0' + minutes : String(minutes);
        var mmss = minutesText + ':' + (secs < 10 ? '0' : '') + secs;
        return hours ? hours + ':' + mmss : mmss;
    }

    function storageKey(problemId, ordinal, src) {
        return STORAGE_PREFIX + problemId + ':' + ordinal + ':' + (src || '');
    }

    /** MIME type guessed from the URL's extension, or null when unknown. */
    function typeForUrl(url) {
        var match = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(url || '');
        return match ? EXTENSION_TYPES[match[1].toLowerCase()] || null : null;
    }

    /* ------------------------------------------------------------------ hls.js */

    /**
     * Call done(Hls) once hls.js is available, or done(null) when it cannot be loaded. Uses RequireJS when the
     * page has it (LMS, Studio): hls.js registers itself as an anonymous AMD module there, so a plain <script>
     * would break. Otherwise injects the vendored file once and shares it between players.
     */
    function loadHls(done) {
        var script;
        function finished() {
            var waiting = hlsWaiting;
            hlsWaiting = null;
            waiting.forEach(function(callback) { callback(root.Hls || null); });
        }
        if (root.Hls) {
            done(root.Hls);
            return;
        }
        if (typeof root.requirejs === 'function') {
            root.requirejs(['hls'], function(Hls) { done(Hls || null); }, function() { done(null); });
            return;
        }
        if (hlsWaiting) {
            hlsWaiting.push(done);
            return;
        }
        if (!root.document) {
            done(null);
            return;
        }
        hlsWaiting = [done];
        script = root.document.createElement('script');
        script.src = HLS_SCRIPT_URL;
        script.async = true;
        script.onload = function() { finished(); };
        script.onerror = function() { finished(); };
        root.document.head.appendChild(script);
    }

    /* ------------------------------------------------------------------ storage */

    function storage() {
        try {
            return root.localStorage || null;
        } catch (e) {
            return null;
        }
    }

    function load(key) {
        var raw = null;
        var data;
        var store = storage();
        try {
            raw = store ? store.getItem(key) : null;
        } catch (e) {
            raw = null;
        }
        if (raw === null && Object.prototype.hasOwnProperty.call(memoryStore, key)) {
            raw = memoryStore[key];
        }
        try {
            data = raw ? JSON.parse(raw) : {};
        } catch (e) {
            data = {};
        }
        return {
            plays: Math.max(0, parseInt(data.plays, 10) || 0),
            ended: data.ended === true,
            position: Math.max(0, parseFloat(data.position) || 0)
        };
    }

    function save(key, state) {
        var raw = JSON.stringify(state);
        var store = storage();
        memoryStore[key] = raw;
        try {
            if (store) {
                store.setItem(key, raw);
            }
        } catch (e) {
            // Quota exceeded or storage disabled: the in-memory copy still covers this page view.
        }
    }

    /** Forget every counter of one problem (called when the learner resets the problem). */
    function clear(problemId) {
        var prefix = STORAGE_PREFIX + problemId + ':';
        var store = storage();
        var keys = [];
        var i;
        Object.keys(memoryStore).forEach(function(key) {
            if (key.indexOf(prefix) === 0) {
                delete memoryStore[key];
            }
        });
        try {
            if (store) {
                for (i = 0; i < store.length; i++) {
                    if (String(store.key(i)).indexOf(prefix) === 0) {
                        keys.push(store.key(i));
                    }
                }
                keys.forEach(function(key) { store.removeItem(key); });
            }
        } catch (e) {
            // Storage unavailable: nothing persisted to clear.
        }
        livePlayers.forEach(function(player) {
            if (player.problemId === problemId) {
                player.reset();
            }
        });
    }

    /* ------------------------------------------------------------------ player */

    /** Set `disabled` on the controls that exist (some are not rendered for limited or compact players). */
    function setDisabled(controls, disabled) {
        controls.forEach(function(control) {
            if (control) {
                control.disabled = disabled; // eslint-disable-line no-param-reassign
            }
        });
    }

    /** Forget players whose problem HTML was replaced, releasing their hls.js instance. */
    function prunePlayers() {
        livePlayers = livePlayers.filter(function(player) {
            var attached = player.audio.ownerDocument.documentElement.contains(player.audio);
            if (!attached) {
                player.destroyHls();
            }
            return attached;
        });
    }

    function pauseOthers(current) {
        prunePlayers();
        livePlayers.forEach(function(player) {
            if (player !== current && !player.audio.paused) {
                player.audio.pause();
            }
        });
    }

    /** Server-side counters `{plays, ended}` from the rendered problem, keyed by audio id, or null if absent. */
    function serverStates(el) {
        var holder = el.querySelector('[data-audio-state]');
        var parsed;
        if (!holder) {
            return null;
        }
        try {
            parsed = JSON.parse(holder.getAttribute('data-audio-state') || '{}');
        } catch (e) {
            return null;
        }
        return parsed && typeof parsed === 'object' ? parsed : null;
    }

    /** Overwrite the play counters with the server's; the resume position stays local. */
    function adoptServerState(state, server) {
        var plays = server ? Math.max(0, parseInt(server.plays, 10) || 0) : 0;
        var ended = server ? server.ended === true : false;
        if (plays !== state.plays || ended !== state.ended) {
            state.position = 0; // eslint-disable-line no-param-reassign
        }
        state.plays = plays; // eslint-disable-line no-param-reassign
        state.ended = ended; // eslint-disable-line no-param-reassign
        return state;
    }

    function Player(container, problemId, ordinal, options) {
        var opts = options || {};
        var skip = parseInt(container.getAttribute('data-skip-seconds'), 10);
        this.container = container;
        this.problemId = problemId;
        this.audio = container.querySelector('audio.capa-audio__media');
        this.controls = container.querySelector('.capa-audio__controls');
        this.playButton = container.querySelector('.capa-audio__play');
        this.backButton = container.querySelector('.capa-audio__skip-back');
        this.forwardButton = container.querySelector('.capa-audio__skip-forward');
        this.seek = container.querySelector('.capa-audio__seek');
        this.progress = container.querySelector('.capa-audio__progress');
        this.fill = container.querySelector('.capa-audio__progress-fill');
        this.timeCurrent = container.querySelector('.capa-audio__time--current');
        this.timeDuration = container.querySelector('.capa-audio__time--duration');
        this.muteButton = container.querySelector('.capa-audio__mute');
        this.volume = container.querySelector('.capa-audio__volume-slider');
        this.speed = container.querySelector('.capa-audio__speed-select');
        this.status = container.querySelector('.capa-audio__status');
        this.title = container.getAttribute('data-title') || t('Audio');
        this.limit = parseLimit(container.getAttribute('data-allow-repeat'));
        this.skipSeconds = skip > 0 ? skip : DEFAULT_SKIP_SECONDS;
        this.key = storageKey(problemId, ordinal, this.audio.getAttribute('src') || this.firstSourceSrc());
        this.state = load(this.key);
        this.audioId = container.getAttribute('data-audio-id');
        this.url = opts.url || null;
        if (opts.serverStates && this.audioId) {
            adoptServerState(this.state, opts.serverStates[this.audioId]);
        } else if (this.audioId && this.url) {
            // The problem was rendered without data-audio-state (an outdated lms/templates/problem.html),
            // so the counters below come from this browser only.
            warn('no data-audio-state in the problem; using the replay counters stored in this browser');
        }
        this.error = null;
        this.hls = null;
        this.hlsUrl = null;
        this.loading = false;
        this.buffering = false;
        this.scrubbing = false;
        this.lastVolume = 1;
        this.lastSave = 0;
    }

    Player.prototype.firstSourceSrc = function() {
        var source = this.audio.querySelector('source');
        return source ? source.getAttribute('src') : '';
    };

    /** Every source of the media as `{url, type}`; type is null when neither declared nor guessable. */
    Player.prototype.candidates = function() {
        var audio = this.audio;
        var list = [];
        var src = audio.getAttribute('src');
        if (src) {
            list.push({url: src, type: typeForUrl(src)});
        }
        Array.prototype.forEach.call(audio.querySelectorAll('source'), function(source) {
            var url = source.getAttribute('src');
            list.push({url: url, type: source.getAttribute('type') || typeForUrl(url)});
        });
        return list;
    };

    /**
     * URL of the HLS playlist to hand to hls.js, or null. Only when the browser has no native HLS and no other
     * source can be played natively.
     */
    Player.prototype.hlsJsSource = function() {
        var audio = this.audio;
        var candidates = this.candidates();
        var hls = candidates.filter(function(candidate) { return candidate.type === HLS_TYPE; })[0];
        if (!hls || typeof audio.canPlayType !== 'function' || audio.canPlayType(HLS_TYPE) !== '') {
            return null;
        }
        return candidates.some(function(candidate) {
            return candidate.type !== HLS_TYPE && (candidate.type === null || audio.canPlayType(candidate.type) !== '');
        }) ? null : hls.url;
    };

    /** Take the sources off the element (stopping the native attempt) and play the playlist through hls.js. */
    Player.prototype.startHls = function(url) {
        var self = this;
        var audio = this.audio;
        audio.removeAttribute('src');
        Array.prototype.forEach.call(audio.querySelectorAll('source'), function(source) {
            audio.removeChild(source);
        });
        if (typeof audio.load === 'function') {
            audio.load(); // also clears the error of the failed native attempt
        }
        this.hlsUrl = url;
        this.loading = true;
        hlsLoader.load(function(Hls) {
            var events;
            self.loading = false;
            if (!audio.ownerDocument.documentElement.contains(audio)) {
                return;
            }
            if (!Hls || typeof Hls.isSupported !== 'function' || !Hls.isSupported()) {
                self.fail(t('This audio format is not supported by your browser.'));
                return;
            }
            events = Hls.Events || {};
            self.hls = new Hls();
            self.hls.on(events.ERROR || 'hlsError', function(event, data) {
                if (data && data.fatal) {
                    self.destroyHls();
                    self.fail(mediaErrorText(2));
                }
            });
            self.hls.loadSource(url);
            self.hls.attachMedia(audio);
            self.render();
        });
    };

    Player.prototype.destroyHls = function() {
        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
    };

    /** True when the browser definitely cannot play any of the given sources. */
    Player.prototype.unsupported = function() {
        var audio = this.audio;
        var candidates = [];
        var src = audio.getAttribute('src');
        if (typeof audio.canPlayType !== 'function') {
            return false;
        }
        if (src) {
            candidates.push(typeForUrl(src));
        }
        Array.prototype.forEach.call(audio.querySelectorAll('source'), function(source) {
            candidates.push(source.getAttribute('type') || typeForUrl(source.getAttribute('src')));
        });
        if (!candidates.length) {
            return false;
        }
        return candidates.every(function(type) {
            return type !== null && audio.canPlayType(type) === '';
        });
    };

    /** True when the browser lets scripts change the volume (iOS does not: the hardware buttons do). */
    Player.prototype.volumeIsSettable = function() {
        var audio = this.audio;
        var previous = audio.volume;
        var probe = previous === 0.5 ? 0.4 : 0.5;
        var settable;
        try {
            audio.volume = probe;
            settable = Math.abs(audio.volume - probe) < 0.01;
            audio.volume = previous;
            return settable;
        } catch (e) {
            return false;
        }
    };

    Player.prototype.start = function() {
        var audio = this.audio;
        var hlsUrl;

        audio.autoplay = false;
        audio.removeAttribute('autoplay');
        audio.removeAttribute('controls');
        audio.controls = false;
        this.controls.hidden = false;

        hlsUrl = this.hlsJsSource();
        if (!hlsUrl && this.unsupported()) {
            this.fail(t('This audio format is not supported by your browser.'));
            return;
        }
        if (this.volume && !this.volumeIsSettable()) {
            this.volume.hidden = true;
            this.container.classList.add('capa-audio--fixed-volume');
        }
        this.bindControls();
        this.bindMedia();

        livePlayers.push(this);
        if (hlsUrl) {
            this.startHls(hlsUrl);
        }
        // The media may have loaded or failed before these listeners were attached.
        if (audio.error) {
            this.onMediaError();
            return;
        }
        if (audio.readyState >= 1) {
            this.restorePosition();
        }
        this.renderVolume();
        this.render();
    };

    Player.prototype.bindControls = function() {
        var self = this;
        this.playButton.addEventListener('click', function() { self.toggle(); });
        if (this.backButton) {
            this.backButton.addEventListener('click', function() {
                self.seekTo(self.audio.currentTime - self.skipSeconds);
            });
        }
        if (this.forwardButton) {
            this.forwardButton.addEventListener('click', function() {
                self.seekTo(self.audio.currentTime + self.skipSeconds);
            });
        }
        if (this.seek) {
            this.seek.addEventListener('input', function() {
                self.scrubbing = true;
                self.renderTime(self.clampTime(parseFloat(self.seek.value) || 0));
            });
            this.seek.addEventListener('change', function() {
                self.scrubbing = false;
                self.seekTo(parseFloat(self.seek.value) || 0);
            });
        }
        if (this.muteButton) {
            this.muteButton.addEventListener('click', function() { self.toggleMute(); });
        }
        if (this.volume) {
            this.volume.addEventListener('input', function() { self.setVolume(self.volume.value); });
        }
        if (this.speed) {
            this.speed.addEventListener('change', function() { self.setRate(self.speed.value); });
        }
    };

    Player.prototype.bindMedia = function() {
        var self = this;
        var audio = this.audio;
        audio.addEventListener('loadedmetadata', function() {
            self.restorePosition();
            self.render();
        });
        audio.addEventListener('durationchange', function() { self.render(); });
        audio.addEventListener('play', function() { self.onPlay(); });
        audio.addEventListener('playing', function() {
            self.buffering = false;
            self.render();
        });
        audio.addEventListener('waiting', function() {
            self.buffering = true;
            self.render();
        });
        audio.addEventListener('pause', function() {
            self.persist(true);
            self.render();
        });
        audio.addEventListener('timeupdate', function() {
            self.persist(false);
            self.render();
        });
        audio.addEventListener('ended', function() {
            self.state.ended = true;
            self.state.position = 0;
            self.persist(true);
            self.report('end');
            self.render();
        });
        audio.addEventListener('volumechange', function() { self.renderVolume(); });
        audio.addEventListener('ratechange', function() { self.renderRate(); });
        audio.addEventListener('error', function() { self.onMediaError(); }, true);
    };

    /** Resume an unfinished play where the learner left it (e.g. before the problem was re-rendered). */
    Player.prototype.restorePosition = function() {
        var position = this.state.position;
        if (this.state.plays > 0 && !this.state.ended && position > 0 && position < this.audio.duration) {
            this.audio.currentTime = position;
        }
    };

    Player.prototype.onPlay = function() {
        var permission = replayState(this.limit, this.state.plays, this.state.ended);
        if (this.error) {
            this.audio.pause();
            return;
        }
        if (this.state.plays === 0 || this.state.ended) {
            if (!permission.canStartNew) {
                // Reached through something other than our button (e.g. hardware media keys).
                this.audio.pause();
                this.render();
                return;
            }
            this.state.plays += 1;
            this.state.ended = false;
            this.state.position = 0;
            this.persist(true);
            this.report('start');
        }
        pauseOthers(this);
        this.render();
    };

    Player.prototype.toggle = function() {
        var self = this;
        var attempt;
        if (!this.audio.paused) {
            this.audio.pause();
            return;
        }
        if (this.error || this.loading || replayState(this.limit, this.state.plays, this.state.ended).locked) {
            return;
        }
        if (this.state.ended) {
            this.audio.currentTime = 0;
        }
        attempt = this.audio.play();
        if (attempt && typeof attempt.catch === 'function') {
            attempt.catch(function(err) {
                if (err && err.name !== 'AbortError') {
                    self.setStatus(t('The audio could not be played.'));
                }
            });
        }
    };

    /** Seeking exists only when replays are unlimited, otherwise rewinding would bypass the limit. */
    Player.prototype.canSeek = function() {
        var duration = this.audio.duration;
        return this.limit === null && !this.error && isFinite(duration) && duration > 0;
    };

    Player.prototype.clampTime = function(seconds) {
        return Math.max(0, Math.min(this.audio.duration, seconds));
    };

    Player.prototype.seekTo = function(seconds) {
        if (!this.canSeek()) {
            return;
        }
        this.audio.currentTime = this.clampTime(seconds);
        this.render();
    };

    Player.prototype.toggleMute = function() {
        var audio = this.audio;
        if (audio.muted || audio.volume === 0) {
            audio.muted = false;
            if (audio.volume === 0) {
                audio.volume = this.lastVolume || 1;
            }
        } else {
            this.lastVolume = audio.volume;
            audio.muted = true;
        }
        this.renderVolume();
    };

    Player.prototype.setVolume = function(value) {
        var audio = this.audio;
        var volume = parseFloat(value);
        audio.volume = isFinite(volume) ? Math.min(Math.max(volume, 0), 1) : 1;
        audio.muted = audio.volume === 0;
        if (audio.volume > 0) {
            this.lastVolume = audio.volume;
        }
        this.renderVolume();
    };

    Player.prototype.setRate = function(value) {
        var rate = parseFloat(value);
        if (isFinite(rate) && rate > 0) {
            this.audio.playbackRate = rate;
            this.audio.defaultPlaybackRate = rate;
        }
        this.renderRate();
    };

    Player.prototype.onMediaError = function() {
        var mediaError = this.audio.error;
        // A failing <source> fires its own error; only give up once the element itself has failed.
        if (!mediaError && this.audio.networkState !== 3) {
            return;
        }
        this.fail(mediaErrorText(mediaError ? mediaError.code : 4));
    };

    Player.prototype.fail = function(message) {
        this.error = message;
        this.render();
    };

    /**
     * Tell the server a play started or ended, and adopt the counters it answers with. A refused start
     * (replay limit reached on the server, e.g. counted on another device) pauses the playback.
     * When the server does not record the play the local counters keep working until the next render
     * (stricter than rolling them back), and the failure is logged so the drift is visible.
     */
    Player.prototype.report = function(event) {
        var self = this;
        var $ = root.$;
        var request;
        if (!this.url || !this.audioId || !$ || typeof $.postWithPrefix !== 'function') {
            warn('audio_play not reported (missing ' + (!this.url ? 'problem url' : !this.audioId ?
                'data-audio-id' : '$.postWithPrefix') + '); counting plays in this browser only');
            return;
        }
        request = $.postWithPrefix(this.url + '/audio_play', {audio_id: this.audioId, event: event}, function(
            response
        ) {
            if (!response || !response.success || !response.state) {
                // e.g. the string "Error: audio_play is not a known capa action" from an outdated LMS.
                warn('audio_play not recorded by the server', event, response);
                return;
            }
            adoptServerState(self.state, response.state);
            if (response.allowed === false && !self.audio.paused) {
                self.audio.pause();
            }
            self.persist(true);
            self.render();
        });
        if (request && typeof request.fail === 'function') {
            request.fail(function(xhr) {
                warn('audio_play request failed', event, xhr && xhr.status);
            });
        }
    };

    Player.prototype.persist = function(force) {
        var now = Date.now();
        if (!force && now - this.lastSave < SAVE_INTERVAL_MS) {
            return;
        }
        this.lastSave = now;
        if (!this.state.ended && this.state.plays > 0 && isFinite(this.audio.currentTime)) {
            this.state.position = this.audio.currentTime;
        }
        save(this.key, this.state);
    };

    Player.prototype.reset = function() {
        this.state = {plays: 0, ended: false, position: 0};
        this.render();
    };

    Player.prototype.setStatus = function(text) {
        if (this.status.textContent !== text) {
            this.status.textContent = text;
        }
    };

    Player.prototype.renderVolume = function() {
        var audio = this.audio;
        var muted = audio.muted || audio.volume === 0;
        this.container.classList.toggle('capa-audio--muted', muted);
        if (this.muteButton) {
            this.muteButton.setAttribute('aria-label', muted ? t('Unmute') : t('Mute'));
        }
        if (this.volume) {
            this.volume.value = String(muted ? 0 : audio.volume);
            this.volume.setAttribute('aria-valuetext', Math.round((muted ? 0 : audio.volume) * 100) + '%');
        }
    };

    Player.prototype.renderRate = function() {
        var rate = this.audio.playbackRate;
        var match;
        if (!this.speed) {
            return;
        }
        match = Array.prototype.filter.call(this.speed.options, function(option) {
            return parseFloat(option.value) === rate;
        })[0];
        if (match) {
            this.speed.value = match.value;
        }
    };

    /** Times, seek bar and progress bar. `preview` is the time under the thumb while the learner drags. */
    Player.prototype.renderTime = function(preview) {
        var audio = this.audio;
        var duration = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
        var current = preview !== undefined ? preview : audio.currentTime || 0;
        var percent = duration ? Math.min(100, (current / duration) * 100) : 0;
        var spoken = format(t('%(current)s of %(duration)s'), {
            current: formatTime(current), duration: formatTime(duration)
        });

        if (this.timeCurrent) {
            this.timeCurrent.textContent = duration || current > 0 ? formatTime(current) : '--:--';
            this.timeDuration.textContent = duration ? formatTime(duration) : '--:--';
        }
        if (this.seek) {
            this.seek.max = String(duration);
            if (!this.scrubbing) {
                this.seek.value = String(current);
            }
            this.seek.setAttribute('aria-valuetext', spoken);
            this.seek.style.setProperty('--capa-audio-progress', percent + '%');
        }
        if (this.progress) {
            this.progress.setAttribute('aria-valuemax', String(Math.round(duration)));
            this.progress.setAttribute('aria-valuenow', String(Math.round(current)));
            this.progress.setAttribute('aria-valuetext', spoken);
            this.fill.style.width = percent + '%';
        }
    };

    Player.prototype.render = function() {
        var audio = this.audio;
        var permission = replayState(this.limit, this.state.plays, this.state.ended);
        var playing = !audio.paused && !audio.ended;
        var seekable = this.canSeek();
        var label;
        var state;

        if (this.error) {
            state = 'error';
        } else if (permission.locked) {
            state = 'limit';
        } else if (this.loading) {
            state = 'loading';
        } else if (playing) {
            state = this.buffering ? 'buffering' : 'playing';
        } else if (this.state.ended) {
            state = 'ended';
        } else {
            state = 'ready';
        }
        this.container.setAttribute('data-state', state);
        this.container.classList.toggle('capa-audio--error', state === 'error');
        this.container.classList.toggle('capa-audio--playing', playing && state !== 'error');

        if (playing) {
            label = t('Pause %(title)s');
        } else if (this.state.ended) {
            label = t('Replay %(title)s');
        } else {
            label = t('Play %(title)s');
        }
        this.playButton.setAttribute('aria-label', format(label, {title: this.title}));
        this.playButton.disabled = state === 'error' || state === 'limit' || state === 'loading';
        setDisabled([this.backButton, this.forwardButton, this.seek], !seekable);
        setDisabled([this.muteButton, this.volume, this.speed], state === 'error');
        this.renderTime();

        if (state === 'error') {
            this.setStatus(this.error);
        } else if (state === 'limit') {
            this.setStatus(t('Replay limit reached.'));
        } else if (state === 'buffering' || state === 'loading') {
            this.setStatus(t('Loading audio…'));
        } else if (permission.remaining !== null) {
            this.setStatus(format(t('Replays remaining: %(count)s'), {count: permission.remaining}));
        } else {
            this.setStatus('');
        }
    };

    /**
     * Start every audio player inside a rendered problem.
     * element: DOM element or jQuery object holding the problem; problemId: the problem's usage id;
     * options.url: the problem's AJAX url, used to report plays to the server.
     */
    function init(element, problemId, options) {
        var el = element && element.jquery ? element[0] : element;
        var opts;
        if (!el || !el.querySelectorAll) {
            return [];
        }
        opts = {url: options && options.url, serverStates: serverStates(el)};
        prunePlayers();
        return Array.prototype.map.call(el.querySelectorAll('.capa-audio'), function(container, ordinal) {
            var player;
            if (container.getAttribute('data-initialized') === 'true' ||
                    !container.querySelector('audio.capa-audio__media')) {
                return null;
            }
            container.setAttribute('data-initialized', 'true');
            player = new Player(container, problemId || '', ordinal, opts);
            player.start();
            return player;
        }).filter(Boolean);
    }

    if (root.addEventListener) {
        root.addEventListener('pagehide', function() {
            livePlayers.forEach(function(player) { player.persist(true); });
        });
    }

    root.CapaAudio = {
        init: init,
        clear: clear,
        internals: {
            parseLimit: parseLimit,
            serverStates: serverStates,
            adoptServerState: adoptServerState,
            replayState: replayState,
            formatTime: formatTime,
            storageKey: storageKey,
            typeForUrl: typeForUrl,
            hlsLoader: hlsLoader,
            loadHls: loadHls,
            load: load,
            save: save,
            memoryStore: memoryStore,
            Player: Player
        }
    };
}).call(this);
