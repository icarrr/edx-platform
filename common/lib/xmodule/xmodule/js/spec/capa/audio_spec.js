/* global Promise */
/* Specs for the embedded capa audio player (src/capa/audio.js). */
describe('CapaAudio', function() {
    'use strict';

    var internal = window.CapaAudio.internals;
    var host;

    // Same markup as capa.customrender.AudioRenderer produces (tests/test_audio_render.py checks the server side).
    function icon(name) {
        return '<svg class="capa-audio__icon capa-audio__icon--' + name + '" viewBox="0 0 24 24" aria-hidden="true"' +
            ' focusable="false"><path d="M8 5v14l11-7z"></path></svg>';
    }

    function button(className, label, content) {
        return '<button type="button" class="capa-audio__btn ' + className + '" disabled="disabled" aria-label="' +
            label + '">' + content + '</button>';
    }

    function playerHtml(options) {
        var opts = options || {};
        var limited = opts.allowRepeat !== undefined;
        var repeat = limited ? String(opts.allowRepeat) : 'unlimited';
        var src = opts.src || 'https://cdn.example.com/q1.mp3';
        var transport = button('capa-audio__btn--primary capa-audio__play', 'Play', icon('play') + icon('pause'));
        var seekRow = '';
        var extras = '';
        if (!opts.compact) {
            if (!limited) {
                transport += button('capa-audio__skip-back', 'Back 10 seconds', icon('skip-back') +
                    '<span class="capa-audio__skip-label" aria-hidden="true">10</span>');
                transport += button('capa-audio__skip-forward', 'Forward 10 seconds',
                    '<span class="capa-audio__skip-label" aria-hidden="true">10</span>' + icon('skip-forward'));
            }
            seekRow = '<div class="capa-audio__seek-row">' +
                '<span class="capa-audio__time capa-audio__time--current" aria-hidden="true">--:--</span>' +
                (limited ?
                    '<div class="capa-audio__progress" role="progressbar" aria-valuemin="0" aria-valuemax="0"' +
                    ' aria-valuenow="0"><span class="capa-audio__progress-fill"></span></div>' :
                    '<input type="range" class="capa-audio__seek" min="0" max="0" step="any" value="0"' +
                    ' aria-label="Seek" disabled="disabled">') +
                '<span class="capa-audio__time capa-audio__time--duration" aria-hidden="true">--:--</span></div>';
            extras = '<div class="capa-audio__extras"><div class="capa-audio__volume">' +
                button('capa-audio__mute', 'Mute', icon('volume') + icon('muted')) +
                '<input type="range" class="capa-audio__volume-slider" min="0" max="1" step="0.05" value="1"' +
                ' aria-label="Volume" disabled="disabled"></div>' +
                '<label class="capa-audio__speed"><span class="capa-audio__visually-hidden">Playback speed</span>' +
                '<select class="capa-audio__speed-select" disabled="disabled">' +
                '<option value="0.75">0.75×</option><option value="1" selected="selected">1×</option>' +
                '<option value="1.25">1.25×</option><option value="1.5">1.5×</option>' +
                '<option value="2">2×</option></select></label></div>';
        }
        return '<div class="capa-audio' + (opts.compact ? ' capa-audio--compact' : '') + '" data-state="loading"' +
            (opts.audioId ? ' data-audio-id="' + opts.audioId + '"' : '') +
            ' data-allow-repeat="' + repeat + '" data-title="' + (opts.title || 'Audio') + '" data-skip-seconds="10"' +
            ' role="group"><div class="capa-audio__player">' +
            '<audio class="capa-audio__media" preload="metadata" controls="controls" src="' + src + '">x</audio>' +
            '<div class="capa-audio__controls" hidden="hidden"><div class="capa-audio__transport">' + transport +
            '</div>' + seekRow + extras + '</div>' +
            '<p class="capa-audio__status" role="status" aria-live="polite"></p></div></div>';
    }

    // Media elements are replaced by a controllable fake: tests drive the events a browser would fire.
    /* eslint-disable no-param-reassign */
    function fakeMedia(audio, canPlay) {
        var state = {
            paused: true,
            ended: false,
            currentTime: 0,
            duration: 45,
            readyState: 1,
            error: null,
            volume: 1,
            muted: false,
            playbackRate: 1,
            defaultPlaybackRate: 1
        };
        Object.keys(state).forEach(function(name) {
            Object.defineProperty(audio, name, {
                configurable: true,
                get: function() { return state[name]; },
                set: function(value) { state[name] = value; }
            });
        });
        audio.canPlayType = function() { return canPlay === undefined ? 'maybe' : canPlay; };
        audio.load = jasmine.createSpy('load');
        audio.play = jasmine.createSpy('play').and.callFake(function() {
            state.paused = false;
            state.ended = false;
            audio.dispatchEvent(new window.Event('play'));
            return Promise.resolve();
        });
        audio.pause = jasmine.createSpy('pause').and.callFake(function() {
            state.paused = true;
            audio.dispatchEvent(new window.Event('pause'));
        });
        audio.finish = function() {
            state.paused = true;
            state.ended = true;
            state.currentTime = state.duration;
            audio.dispatchEvent(new window.Event('ended'));
        };
        return audio;
    }
    /* eslint-enable no-param-reassign */

    function mount(html, problemId, canPlay, options) {
        var el = document.createElement('div');
        el.innerHTML = html;
        host.appendChild(el);
        Array.prototype.forEach.call(el.querySelectorAll('audio'), function(audio) { fakeMedia(audio, canPlay); });
        return {
            el: el,
            players: window.CapaAudio.init(el, problemId || 'block-v1:Org+C+R+type@problem+block@p1', options)
        };
    }

    /** A rendered problem (problem.html) carrying the server's counters, as audio.js finds it. */
    function problemHtml(serverState, player) {
        var state = JSON.stringify(serverState).replace(/"/g, '&quot;');
        return '<div class="problem" data-audio-state="' + state + '">' + player + '</div>';
    }

    function parts(player) {
        return {
            container: player.container,
            audio: player.audio,
            button: player.playButton,
            status: player.status
        };
    }

    function listenToEnd(player) {
        player.playButton.click();
        player.audio.finish();
    }

    beforeEach(function() {
        host = document.createElement('div');
        document.body.appendChild(host);
        try {
            window.localStorage.clear();
        } catch (e) {
            // storage unavailable in this browser: the in-memory store is used instead
        }
        Object.keys(internal.memoryStore).forEach(function(key) { delete internal.memoryStore[key]; });
    });

    afterEach(function() {
        document.body.removeChild(host);
    });

    describe('helpers', function() {
        it('parses allow-repeat', function() {
            expect(internal.parseLimit('3')).toBe(3);
            expect(internal.parseLimit('0')).toBe(0);
            expect(internal.parseLimit('unlimited')).toBeNull();
            expect(internal.parseLimit('')).toBeNull();
            expect(internal.parseLimit(null)).toBeNull();
            expect(internal.parseLimit('-1')).toBeNull();
        });

        it('allows the initial play plus allow-repeat replays', function() {
            expect(internal.replayState(3, 0, false)).toEqual({canStartNew: true, locked: false, remaining: 3});
            expect(internal.replayState(3, 1, true)).toEqual({canStartNew: true, locked: false, remaining: 3});
            expect(internal.replayState(3, 2, true)).toEqual({canStartNew: true, locked: false, remaining: 2});
            expect(internal.replayState(3, 4, false)).toEqual({canStartNew: false, locked: false, remaining: 0});
            expect(internal.replayState(3, 4, true)).toEqual({canStartNew: false, locked: true, remaining: 0});
            expect(internal.replayState(0, 1, true).locked).toBe(true);
        });

        it('never locks without a limit', function() {
            expect(internal.replayState(null, 50, true)).toEqual({canStartNew: true, locked: false, remaining: null});
        });

        it('formats times', function() {
            expect(internal.formatTime(0)).toBe('0:00');
            expect(internal.formatTime(65.7)).toBe('1:05');
            expect(internal.formatTime(3725)).toBe('1:02:05');
            expect(internal.formatTime(NaN)).toBe('0:00');
            expect(internal.formatTime(Infinity)).toBe('0:00');
        });

        it('guesses the MIME type from the extension', function() {
            expect(internal.typeForUrl('https://x/a.mp3')).toBe('audio/mpeg');
            expect(internal.typeForUrl('https://x/a.M4A?token=1')).toBe('audio/mp4');
            expect(internal.typeForUrl('https://x/a.ogg#t=3')).toBe('audio/ogg');
            expect(internal.typeForUrl('https://x/stream')).toBeNull();
            expect(internal.typeForUrl('https://x/id/playlist.m3u8')).toBe('application/vnd.apple.mpegurl');
        });
    });

    describe('player', function() {
        it('does nothing for problems without audio', function() {
            expect(mount('<p>No audio here</p>').players).toEqual([]);
        });

        it('replaces native controls with its own and never autoplays', function() {
            var player = mount(playerHtml({allowRepeat: 2})).players[0];
            var p = parts(player);
            expect(p.audio.hasAttribute('controls')).toBe(false);
            expect(p.audio.autoplay).toBe(false);
            expect(p.audio.play).not.toHaveBeenCalled();
            expect(player.controls.hidden).toBe(false);
            expect(p.button.disabled).toBe(false);
            expect(p.status.textContent).toBe('Replays remaining: 2');
        });

        it('initializes each container only once', function() {
            var mounted = mount(playerHtml());
            expect(window.CapaAudio.init(mounted.el, 'p1')).toEqual([]);
        });

        it('plays and pauses from the play button', function() {
            var p = parts(mount(playerHtml()).players[0]);
            p.button.click();
            expect(p.audio.play).toHaveBeenCalled();
            expect(p.container.getAttribute('data-state')).toBe('playing');
            expect(p.button.getAttribute('aria-label')).toBe('Pause Audio');
            p.button.click();
            expect(p.audio.pause).toHaveBeenCalled();
            expect(p.container.getAttribute('data-state')).toBe('ready');
        });

        it('does not count pause and resume as a replay', function() {
            var player = mount(playerHtml({allowRepeat: 2})).players[0];
            var i;
            player.playButton.click();
            for (i = 0; i < 3; i++) {
                player.playButton.click(); // pause
                player.playButton.click(); // resume
            }
            expect(player.state.plays).toBe(1);
            expect(player.audio.paused).toBe(false);
            expect(player.status.textContent).toBe('Replays remaining: 2');
        });

        it('locks a single-play audio after it ends, even with pauses in between', function() {
            var player = mount(playerHtml({allowRepeat: 0})).players[0];
            player.playButton.click();
            player.playButton.click(); // pause
            player.playButton.click(); // resume
            expect(player.audio.paused).toBe(false);
            player.audio.finish();
            expect(player.container.getAttribute('data-state')).toBe('limit');
        });

        it('enforces the replay limit', function() {
            var player = mount(playerHtml({allowRepeat: 1})).players[0];
            var p = parts(player);

            listenToEnd(player);
            expect(p.status.textContent).toBe('Replays remaining: 1');
            expect(p.button.disabled).toBe(false);
            expect(p.button.getAttribute('aria-label')).toBe('Replay Audio');

            listenToEnd(player);
            expect(player.state.plays).toBe(2);
            expect(p.button.disabled).toBe(true);
            expect(p.container.getAttribute('data-state')).toBe('limit');
            expect(p.status.textContent).toBe('Replay limit reached.');

            p.audio.play.calls.reset();
            player.toggle();
            expect(p.audio.play).not.toHaveBeenCalled();
        });

        it('stops playback started outside its button once the limit is reached', function() {
            var player = mount(playerHtml({allowRepeat: 0})).players[0];
            listenToEnd(player);
            player.audio.pause.calls.reset();
            player.audio.dispatchEvent(new window.Event('play')); // e.g. hardware media key
            expect(player.audio.pause).toHaveBeenCalled();
            expect(player.state.plays).toBe(1);
        });

        it('allows unlimited replays when allow-repeat is omitted', function() {
            var player = mount(playerHtml()).players[0];
            var i;
            for (i = 0; i < 6; i++) {
                listenToEnd(player);
            }
            expect(player.state.plays).toBe(6);
            expect(player.playButton.disabled).toBe(false);
            expect(player.status.textContent).toBe('');
        });

        it('keeps independent counters for every audio element', function() {
            var players = mount(playerHtml({allowRepeat: 0}) + playerHtml({allowRepeat: 0})).players;
            listenToEnd(players[0]);
            expect(players[0].playButton.disabled).toBe(true);
            expect(players[1].playButton.disabled).toBe(false);
            expect(players[1].state.plays).toBe(0);
        });

        it('pauses the other players when one starts', function() {
            var players = mount(playerHtml({src: 'https://x/a.mp3'}) + playerHtml({src: 'https://x/b.mp3'})).players;
            players[0].playButton.click();
            players[1].playButton.click();
            expect(players[0].audio.pause).toHaveBeenCalled();
            expect(players[0].audio.paused).toBe(true);
        });

        it('keeps counters across a re-render of the problem (e.g. after submit)', function() {
            var first = mount(playerHtml({allowRepeat: 0}), 'p-rerender').players[0];
            var second;
            listenToEnd(first);
            host.innerHTML = '';
            second = mount(playerHtml({allowRepeat: 0}), 'p-rerender').players[0];
            expect(second.state.plays).toBe(1);
            expect(second.playButton.disabled).toBe(true);
        });

        it('resumes an unfinished play without spending a replay', function() {
            var first = mount(playerHtml({allowRepeat: 0}), 'p-resume').players[0];
            var second;
            first.playButton.click();
            first.audio.currentTime = 20;
            first.audio.pause();
            host.innerHTML = '';
            second = mount(playerHtml({allowRepeat: 0}), 'p-resume').players[0];
            expect(second.audio.currentTime).toBe(20);
            second.playButton.click();
            expect(second.state.plays).toBe(1);
            expect(second.playButton.disabled).toBe(false);
        });

        it('gives the replays back when the problem is reset', function() {
            var player = mount(playerHtml({allowRepeat: 0}), 'p-reset').players[0];
            var other = mount(playerHtml({allowRepeat: 0}), 'p-other').players[0];
            listenToEnd(player);
            listenToEnd(other);
            window.CapaAudio.clear('p-reset');
            host.innerHTML = '';
            expect(mount(playerHtml({allowRepeat: 0}), 'p-reset').players[0].state.plays).toBe(0);
            expect(mount(playerHtml({allowRepeat: 0}), 'p-other').players[0].state.plays).toBe(1);
        });

        it('does not let a player still on the page restore counters cleared by a reset', function() {
            // The old DOM's player can fire a late "pause" (and save) after the reset cleared storage.
            var player = mount(playerHtml({allowRepeat: 0}), 'p-late').players[0];
            listenToEnd(player);
            window.CapaAudio.clear('p-late');
            expect(player.playButton.disabled).toBe(false);
            player.audio.dispatchEvent(new window.Event('pause'));
            host.innerHTML = '';
            expect(mount(playerHtml({allowRepeat: 0}), 'p-late').players[0].state.plays).toBe(0);
        });

        it('treats a changed source as a new audio', function() {
            listenToEnd(mount(playerHtml({allowRepeat: 0, src: 'https://x/old.mp3'}), 'p-src').players[0]);
            host.innerHTML = '';
            expect(mount(playerHtml({allowRepeat: 0, src: 'https://x/new.mp3'}), 'p-src').players[0].state.plays)
                .toBe(0);
        });

        it('shows a message when the audio cannot be loaded', function() {
            var player = mount(playerHtml()).players[0];
            player.audio.error = {code: 4};
            player.audio.dispatchEvent(new window.Event('error'));
            expect(player.container.getAttribute('data-state')).toBe('error');
            expect(player.playButton.disabled).toBe(true);
            expect(player.status.textContent).toContain('could not be found');
        });

        it('reports HLS playlists as unsupported where neither the browser nor hls.js can play them', function() {
            var player;
            spyOn(internal.hlsLoader, 'load').and.callFake(function(done) { done(null); });
            player = mount(playerHtml({src: 'https://x/playlist.m3u8'}), 'p-hls', '').players[0];
            expect(player.container.getAttribute('data-state')).toBe('error');
            expect(player.status.textContent).toBe('This audio format is not supported by your browser.');
        });

        it('shows a message for formats the browser cannot play', function() {
            var player = mount(playerHtml({src: 'https://x/a.ogg'}), 'p-format', '').players[0];
            expect(player.container.getAttribute('data-state')).toBe('error');
            expect(player.status.textContent).toBe('This audio format is not supported by your browser.');
        });

        it('enables seeking and skipping only when replays are unlimited', function() {
            var unlimited = mount(playerHtml()).players[0];
            var limited = mount(playerHtml({allowRepeat: 2})).players[0];
            expect(unlimited.seek.disabled).toBe(false);
            expect(unlimited.backButton.disabled).toBe(false);
            expect(unlimited.forwardButton.disabled).toBe(false);
            expect(unlimited.seek.max).toBe('45');
            expect(limited.seek).toBeNull();
            expect(limited.backButton).toBeNull();
            expect(limited.progress.getAttribute('role')).toBe('progressbar');
            limited.seekTo(30);
            expect(limited.audio.currentTime).toBe(0);
        });

        it('keeps seek controls disabled until the duration is known', function() {
            var html = playerHtml();
            var el = document.createElement('div');
            var player;
            el.innerHTML = html;
            host.appendChild(el);
            fakeMedia(el.querySelector('audio'));
            el.querySelector('audio').duration = NaN;
            player = window.CapaAudio.init(el, 'p-nan')[0];
            expect(player.seek.disabled).toBe(true);
            expect(player.forwardButton.disabled).toBe(true);
            expect(player.playButton.disabled).toBe(false);
            expect(player.timeDuration.textContent).toBe('--:--');
            player.audio.duration = 45;
            player.audio.dispatchEvent(new window.Event('loadedmetadata'));
            expect(player.seek.disabled).toBe(false);
            expect(player.timeDuration.textContent).toBe('0:45');
        });

        it('seeks when the learner releases the seek bar, previewing the time while dragging', function() {
            var player = mount(playerHtml()).players[0];
            player.seek.value = '30';
            player.seek.dispatchEvent(new window.Event('input'));
            expect(player.timeCurrent.textContent).toBe('0:30');
            expect(player.audio.currentTime).toBe(0);
            player.seek.dispatchEvent(new window.Event('change'));
            expect(player.audio.currentTime).toBe(30);
            expect(player.seek.getAttribute('aria-valuetext')).toBe('0:30 of 0:45');
        });

        it('skips back and forward by ten seconds within the audio', function() {
            var player = mount(playerHtml()).players[0];
            player.forwardButton.click();
            expect(player.audio.currentTime).toBe(10);
            player.forwardButton.click();
            player.forwardButton.click();
            player.forwardButton.click();
            player.forwardButton.click();
            expect(player.audio.currentTime).toBe(45);
            player.audio.currentTime = 5;
            player.backButton.click();
            expect(player.audio.currentTime).toBe(0);
        });

        it('does not count seeking as a replay', function() {
            var player = mount(playerHtml()).players[0];
            player.playButton.click();
            player.forwardButton.click();
            player.backButton.click();
            expect(player.state.plays).toBe(1);
        });

        it('mutes, unmutes and restores the previous volume', function() {
            var player = mount(playerHtml()).players[0];
            expect(player.muteButton.disabled).toBe(false);
            player.volume.value = '0.4';
            player.volume.dispatchEvent(new window.Event('input'));
            expect(player.audio.volume).toBe(0.4);
            player.muteButton.click();
            expect(player.audio.muted).toBe(true);
            expect(player.container.classList.contains('capa-audio--muted')).toBe(true);
            expect(player.muteButton.getAttribute('aria-label')).toBe('Unmute');
            expect(player.volume.value).toBe('0');
            player.muteButton.click();
            expect(player.audio.muted).toBe(false);
            expect(player.volume.value).toBe('0.4');
            expect(player.volume.getAttribute('aria-valuetext')).toBe('40%');
        });

        it('treats dragging the volume to zero as muted and unmutes to the last volume', function() {
            var player = mount(playerHtml()).players[0];
            player.volume.value = '0';
            player.volume.dispatchEvent(new window.Event('input'));
            expect(player.audio.muted).toBe(true);
            player.muteButton.click();
            expect(player.audio.muted).toBe(false);
            expect(player.audio.volume).toBe(1);
        });

        it('hides the volume slider where scripts cannot set the volume (iOS)', function() {
            var el = document.createElement('div');
            var audio;
            var player;
            el.innerHTML = playerHtml();
            host.appendChild(el);
            audio = fakeMedia(el.querySelector('audio'));
            Object.defineProperty(audio, 'volume', {
                configurable: true,
                get: function() { return 1; },
                set: function() {}
            });
            player = window.CapaAudio.init(el, 'p-ios')[0];
            expect(player.volume.hidden).toBe(true);
            expect(player.container.classList.contains('capa-audio--fixed-volume')).toBe(true);
            expect(player.muteButton.disabled).toBe(false);
        });

        it('changes the playback speed', function() {
            var player = mount(playerHtml({allowRepeat: 1})).players[0];
            expect(player.speed.disabled).toBe(false);
            player.speed.value = '1.5';
            player.speed.dispatchEvent(new window.Event('change'));
            expect(player.audio.playbackRate).toBe(1.5);
            expect(player.audio.defaultPlaybackRate).toBe(1.5);
            player.audio.playbackRate = 0.75;
            player.audio.dispatchEvent(new window.Event('ratechange'));
            expect(player.speed.value).toBe('0.75');
        });

        it('swaps the play and pause icons through a state class', function() {
            var player = mount(playerHtml()).players[0];
            player.playButton.click();
            expect(player.container.classList.contains('capa-audio--playing')).toBe(true);
            player.playButton.click();
            expect(player.container.classList.contains('capa-audio--playing')).toBe(false);
        });

        it('disables every control after a media error', function() {
            var player = mount(playerHtml()).players[0];
            player.audio.error = {code: 2};
            player.audio.dispatchEvent(new window.Event('error'));
            [player.playButton, player.backButton, player.forwardButton, player.seek, player.muteButton,
                player.volume, player.speed].forEach(function(control) {
                expect(control.disabled).toBe(true);
            });
        });

        it('renders the compact player with the play button only', function() {
            var player = mount(playerHtml({compact: true, allowRepeat: 1})).players[0];
            expect(player.seek).toBeNull();
            expect(player.muteButton).toBeNull();
            expect(player.speed).toBeNull();
            listenToEnd(player);
            expect(player.status.textContent).toBe('Replays remaining: 1');
        });

        it('shows a display-only progress bar when replays are limited', function() {
            var player = mount(playerHtml({allowRepeat: 2})).players[0];
            player.audio.currentTime = 15;
            player.audio.dispatchEvent(new window.Event('timeupdate'));
            expect(player.timeCurrent.textContent).toBe('0:15');
            expect(player.timeDuration.textContent).toBe('0:45');
            expect(player.progress.getAttribute('aria-valuenow')).toBe('15');
            expect(player.fill.style.width).toBe('33.33333333333333%');
        });

        it('updates the seek bar fill as the audio plays', function() {
            var player = mount(playerHtml()).players[0];
            player.audio.currentTime = 22.5;
            player.audio.dispatchEvent(new window.Event('timeupdate'));
            expect(player.seek.value).toBe('22.5');
            expect(player.seek.style.getPropertyValue('--capa-audio-progress')).toBe('50%');
        });
    });

    describe('server state', function() {
        var URL = '/courses/c/xblock/p1/handler/xmodule_handler';
        var answer;

        beforeEach(function() {
            answer = null;
            spyOn($, 'postWithPrefix').and.callFake(function(url, data, callback) {
                if (answer) {
                    callback(answer(data));
                }
            });
        });

        function mountServer(serverState, allowRepeat, problemId) {
            var html = problemHtml(serverState, playerHtml({allowRepeat: allowRepeat, audioId: 'a1'}));
            return mount(html, problemId || 'p-server', undefined, {url: URL}).players[0];
        }

        it('takes the play counters from the server over local storage', function() {
            listenToEnd(mount(playerHtml({allowRepeat: 1, audioId: 'a1'}), 'p-server').players[0]);
            host.innerHTML = '';
            // Played once in this browser, never according to the server (e.g. a reset on another device).
            expect(mountServer({}, 1).status.textContent).toBe('Replays remaining: 1');
            host.innerHTML = '';
            // Limit already used up on another device.
            expect(mountServer({a1: {plays: 2, ended: true}}, 1).playButton.disabled).toBe(true);
        });

        it('keeps the local resume position when the counters agree', function() {
            var first = mountServer({}, 1);
            first.playButton.click();
            first.audio.currentTime = 12;
            first.audio.pause();
            host.innerHTML = '';
            expect(mountServer({a1: {plays: 1, ended: false}}, 1).audio.currentTime).toBe(12);
        });

        it('reports the start and the end of a play', function() {
            listenToEnd(mountServer({}, 1));
            expect($.postWithPrefix.calls.count()).toBe(2);
            expect($.postWithPrefix.calls.argsFor(0).slice(0, 2)).toEqual(
                [URL + '/audio_play', {audio_id: 'a1', event: 'start'}]
            );
            expect($.postWithPrefix.calls.argsFor(1)[1]).toEqual({audio_id: 'a1', event: 'end'});
        });

        it('does not report pause and resume', function() {
            var player = mountServer({}, 1);
            player.playButton.click();
            player.audio.pause();
            player.playButton.click();
            expect($.postWithPrefix.calls.count()).toBe(1);
        });

        it('pauses and locks when the server refuses a new play', function() {
            var player = mountServer({}, 1);
            answer = function() {
                return {success: true, allowed: false, state: {plays: 2, ended: true}};
            };
            player.playButton.click();
            expect(player.audio.pause).toHaveBeenCalled();
            expect(player.audio.paused).toBe(true);
            expect(player.state.plays).toBe(2);
            expect(player.playButton.disabled).toBe(true);
            expect(player.status.textContent).toBe('Replay limit reached.');
        });

        it('keeps playing on its local counters when the server cannot be reached', function() {
            var player = mountServer({}, 1);
            player.playButton.click();
            expect(player.audio.paused).toBe(false);
            expect(player.state.plays).toBe(1);
        });

        it('ignores an unusable server answer', function() {
            var player = mountServer({}, 1);
            answer = function() { return {success: false}; };
            player.playButton.click();
            expect(player.audio.paused).toBe(false);
            expect(player.state.plays).toBe(1);
        });

        it('falls back to local counters when the problem carries no server state', function() {
            listenToEnd(mount(playerHtml({allowRepeat: 0, audioId: 'a1'}), 'p-local').players[0]);
            host.innerHTML = '';
            expect(mount(playerHtml({allowRepeat: 0, audioId: 'a1'}), 'p-local', undefined, {url: URL})
                .players[0].playButton.disabled).toBe(true);
        });

        it('warns when the server does not record a play', function() {
            var player = mountServer({}, 1);
            spyOn(window.console, 'warn');
            answer = function() { return 'Error: audio_play is not a known capa action'; };
            player.playButton.click();
            expect(window.console.warn).toHaveBeenCalledWith(
                '[CapaAudio]', 'audio_play not recorded by the server', 'start',
                'Error: audio_play is not a known capa action'
            );
        });

        it('warns when the play request fails', function() {
            var failed;
            $.postWithPrefix.and.returnValue({fail: function(callback) { failed = callback; }});
            spyOn(window.console, 'warn');
            mountServer({}, 1).playButton.click();
            failed({status: 500});
            expect(window.console.warn).toHaveBeenCalledWith('[CapaAudio]', 'audio_play request failed', 'start', 500);
        });

        it('warns when a play cannot be reported at all', function() {
            var player;
            spyOn(window.console, 'warn');
            player = mount(playerHtml({allowRepeat: 1}), 'p-nourl').players[0];
            player.playButton.click();
            expect(window.console.warn.calls.mostRecent().args[1]).toContain('audio_play not reported');
        });

        it('warns when the problem carries no server state', function() {
            spyOn(window.console, 'warn');
            mount(playerHtml({allowRepeat: 1, audioId: 'a1'}), 'p-nostate', undefined, {url: URL});
            expect(window.console.warn.calls.mostRecent().args[1]).toContain('no data-audio-state');
        });

        it('parses a missing or broken data-audio-state as absent', function() {
            var el = document.createElement('div');
            expect(internal.serverStates(el)).toBeNull();
            el.innerHTML = '<div data-audio-state="{oops"></div>';
            expect(internal.serverStates(el)).toBeNull();
        });
    });

    describe('HLS', function() {
        var PLAYLIST = 'https://vz-1.b-cdn.net/abc/playlist.m3u8';
        var supported;
        var pending;

        function FakeHls() {
            FakeHls.instances.push(this);
            this.handlers = {};
            this.loadSource = jasmine.createSpy('loadSource');
            this.attachMedia = jasmine.createSpy('attachMedia');
            this.destroy = jasmine.createSpy('destroy');
        }
        FakeHls.prototype.on = function(name, handler) { this.handlers[name] = handler; };
        FakeHls.isSupported = function() { return supported; };
        FakeHls.Events = {ERROR: 'hlsError'};

        beforeEach(function() {
            FakeHls.instances = [];
            supported = true;
            pending = null;
            spyOn(internal.hlsLoader, 'load').and.callFake(function(done) {
                pending = done;
            });
        });

        function mountHls(html, canPlay) {
            var player = mount(html || playerHtml({allowRepeat: 1, src: PLAYLIST}), 'p-hls', canPlay).players[0];
            return player;
        }

        it('plays natively where the browser supports HLS', function() {
            var player = mountHls(null, 'maybe');
            expect(internal.hlsLoader.load).not.toHaveBeenCalled();
            expect(player.audio.getAttribute('src')).toBe(PLAYLIST);
        });

        it('hands the playlist to hls.js elsewhere', function() {
            var player = mountHls(null, '');
            var hls;
            expect(player.audio.hasAttribute('src')).toBe(false);
            expect(player.audio.load).toHaveBeenCalled();
            expect(player.container.getAttribute('data-state')).toBe('loading');
            expect(player.playButton.disabled).toBe(true);
            pending(FakeHls);
            hls = FakeHls.instances[0];
            expect(hls.loadSource).toHaveBeenCalledWith(PLAYLIST);
            expect(hls.attachMedia).toHaveBeenCalledWith(player.audio);
            expect(player.playButton.disabled).toBe(false);
            expect(player.status.textContent).toBe('Replays remaining: 1');
        });

        it('counts plays of an HLS audio like any other', function() {
            var player = mountHls(null, '');
            pending(FakeHls);
            listenToEnd(player);
            listenToEnd(player);
            expect(player.state.plays).toBe(2);
            expect(player.playButton.disabled).toBe(true);
        });

        it('ignores clicks while hls.js is loading', function() {
            var player = mountHls(null, '');
            player.playButton.click();
            player.toggle();
            expect(player.audio.play).not.toHaveBeenCalled();
        });

        it('takes the playlist from a <source> child too', function() {
            var html = playerHtml({src: PLAYLIST}).replace(
                ' src="' + PLAYLIST + '">x</audio>', '><source src="' + PLAYLIST + '">x</audio>'
            );
            var player = mountHls(html, '');
            pending(FakeHls);
            expect(player.audio.querySelector('source')).toBeNull();
            expect(FakeHls.instances[0].loadSource).toHaveBeenCalledWith(PLAYLIST);
        });

        it('shows the unsupported message when hls.js cannot run (no MediaSource)', function() {
            var player = mountHls(null, '');
            supported = false;
            pending(FakeHls);
            expect(FakeHls.instances.length).toBe(0);
            expect(player.container.getAttribute('data-state')).toBe('error');
            expect(player.status.textContent).toBe('This audio format is not supported by your browser.');
        });

        it('shows a network error on a fatal hls.js error, but not on a recoverable one', function() {
            var player = mountHls(null, '');
            var hls;
            pending(FakeHls);
            hls = FakeHls.instances[0];
            hls.handlers.hlsError('hlsError', {fatal: false});
            expect(player.error).toBeNull();
            hls.handlers.hlsError('hlsError', {fatal: true});
            expect(hls.destroy).toHaveBeenCalled();
            expect(player.status.textContent).toBe('A network error stopped the audio from loading.');
        });

        it('does not load hls.js for regular audio files', function() {
            mountHls(playerHtml({src: 'https://x/a.mp3'}), '');
            mountHls(playerHtml({src: 'https://x/b.mp3'}), 'maybe');
            expect(internal.hlsLoader.load).not.toHaveBeenCalled();
        });

        it('releases hls.js when the problem is re-rendered', function() {
            var player = mountHls(null, '');
            pending(FakeHls);
            host.innerHTML = '';
            mount(playerHtml({src: 'https://x/a.mp3'}), 'p-other');
            expect(FakeHls.instances[0].destroy).toHaveBeenCalled();
            expect(player.hls).toBeNull();
        });
    });
});
