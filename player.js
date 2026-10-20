/*
 * eastla_tv screen page. Runs inside an off-screen browser (DUI) per TV and is
 * drawn onto the TV in the world. Lua sends it the synced state; it plays the
 * media and keeps itself within Config.SyncTolerance seconds of the server clock.
 * This page has no FiveM-only APIs, so it can also be hosted on any HTTPS site
 * (Config.ExternalDuiUrl) if YouTube refuses the cfx-nui origin.
 */
(() => {
    'use strict';

    const qs = new URLSearchParams(location.search);
    const RES = qs.get('res') || 'eastla_tv';
    const SLOT = parseInt(qs.get('slot') || '0', 10);
    const $ = (id) => document.getElementById(id);

    const REASONS = {
        yt_2: 'Invalid video link',
        yt_5: 'The player hit an error',
        yt_100: 'Video unavailable or private',
        yt_101: 'The uploader blocked playback outside YouTube',
        yt_150: 'The uploader blocked playback outside YouTube',
        yt_153: 'YouTube rejected the TV player (error 153)',
        yt_api: 'Could not reach YouTube',
        tw_api: 'Could not reach Twitch',
        media_1: 'Playback was aborted',
        media_2: 'Network error while loading',
        media_3: 'The file could not be decoded',
        media_4: 'Format not supported',
        media_hls: 'The stream could not be loaded',
        image: 'The image could not be loaded',
    };

    const cfg = { tolerance: 1.5, branding: {} };
    const desired = { playing: false, pos: 0, at: performance.now() };

    let screenId = null;
    let media = null;       // current media (copy of the server's)
    let mode = null;        // youtube | twitch | video | audio | image
    let volume = 0;         // 0-100, already attenuated by the game
    let holdMute = false;   // stay silent until a paused load has been paused
    let firstPlayUid = null;
    let endedUid = null;
    let errorUid = null;
    let loadingTimer = null;
    let noticeTimer = null;
    let greeted = false;

    // ------------------------------------------------------------------ plumbing

    function post(event, data) {
        const body = Object.assign({ slot: SLOT, screen: screenId, event }, data || {});
        try {
            fetch(`https://${RES}/dui`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=UTF-8' },
                body: JSON.stringify(body),
            }).catch(() => {});
        } catch (e) { /* not inside FiveM */ }
    }

    const expected = () => (desired.playing ? desired.pos + (performance.now() - desired.at) / 1000 : desired.pos);

    const scripts = {};
    function loadScript(src) {
        if (!scripts[src]) {
            scripts[src] = new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = src;
                s.async = true;
                s.onload = () => resolve();
                s.onerror = () => {
                    delete scripts[src];
                    reject(new Error(`failed to load ${src}`));
                };
                document.head.appendChild(s);
            });
        }
        return scripts[src];
    }

    const localUrl = (file) => `https://cfx-nui-${RES}/media/${encodeURIComponent(file)}`;

    // ------------------------------------------------------------------ view

    const LAYERS = ['ytWrap', 'tw', 'video', 'image', 'audio', 'idle'];
    function setLayer(name) {
        for (const id of LAYERS) $(id).classList.toggle('on', id === name);
    }

    function loading(on) {
        clearTimeout(loadingTimer);
        // Twitch refuses to autoplay when anything is drawn over its player, so no overlay for it
        if (on && mode !== 'twitch') {
            loadingTimer = setTimeout(() => $('loading').classList.add('on'), 350);
        } else {
            $('loading').classList.remove('on');
        }
    }

    function notice(text) {
        $('noticeText').textContent = text;
        $('notice').classList.add('on');
        clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => $('notice').classList.remove('on'), 7000);
    }

    function hideNotice() {
        clearTimeout(noticeTimer);
        $('notice').classList.remove('on');
    }

    function updateBadges() {
        const has = !!media && mode !== null;
        const visual = has && mode !== 'image';
        $('pausedBadge').classList.toggle('on', visual && !desired.playing);
        $('liveBadge').classList.toggle('on', visual && !!media.live);
        $('bug').classList.toggle('on', visual && desired.playing && cfg.branding.bug !== false);
        $('eq').classList.toggle('paused', !desired.playing);
    }

    function fillAudio(m) {
        $('audioTitle').textContent = m.title || 'Untitled';
        $('audioSub').textContent = m.author || (m.file ? 'Library' : '');
        const art = $('audioArt');
        const bg = $('audioBg');
        if (m.thumb) {
            const url = `url("${String(m.thumb).replace(/"/g, '%22')}")`;
            art.style.backgroundImage = url;
            bg.style.backgroundImage = url;
            art.classList.add('has-img');
        } else {
            art.style.backgroundImage = '';
            bg.style.backgroundImage = 'linear-gradient(135deg, #0f3d2e, #07090b)';
            art.classList.remove('has-img');
        }
    }

    function tickClock() {
        $('clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }

    function fail(code) {
        if (!media || errorUid === media.uid) return;
        errorUid = media.uid;
        loading(false);
        notice(REASONS[code] || 'Playback error');
        post('error', { uid: media.uid, code });
    }

    // ------------------------------------------------------------------ YouTube

    const YT_PLAYING = 1;
    const YT_ENDED = 0;
    const YT_PAUSED = 2;
    const YT_BUFFERING = 3;

    const yt = {
        player: null,
        ready: false,
        state: -1,
        queued: null,
        pending: null,
        apiLoading: false,

        ensure(cb) {
            if (window.YT && window.YT.Player) {
                cb();
                return;
            }
            yt.pending = cb;
            if (yt.apiLoading) return;
            yt.apiLoading = true;
            window.onYouTubeIframeAPIReady = () => {
                const fn = yt.pending;
                yt.pending = null;
                if (fn) fn();
            };
            loadScript('https://www.youtube.com/iframe_api').catch(() => {
                yt.apiLoading = false;
                fail('yt_api');
            });
        },

        load(m) {
            const startAt = m.live ? 0 : Math.max(0, Math.floor(expected()));
            yt.ensure(() => {
                if (!media || media.uid !== m.uid) return;
                if (!yt.player) {
                    const vars = {
                        autoplay: 1, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, rel: 0,
                        playsinline: 1, modestbranding: 1, cc_load_policy: 0, enablejsapi: 1,
                        widget_referrer: location.href,
                    };
                    if (!m.live) vars.start = startAt;
                    if (location.origin && location.origin !== 'null') vars.origin = location.origin;
                    yt.player = new window.YT.Player('yt', {
                        width: '100%',
                        height: '100%',
                        videoId: m.id,
                        host: 'https://www.youtube.com',
                        playerVars: vars,
                        events: {
                            onReady: yt.onReady,
                            onStateChange: yt.onState,
                            onError: (e) => fail(`yt_${e.data}`),
                        },
                    });
                } else if (yt.ready) {
                    yt.player.loadVideoById(m.live ? { videoId: m.id } : { videoId: m.id, startSeconds: startAt });
                    yt.applyVolume();
                } else {
                    yt.queued = m; // player still starting up, onReady picks it up
                }
            });
        },

        onReady() {
            yt.ready = true;
            yt.applyVolume();
            const q = yt.queued;
            yt.queued = null;
            if (q && media && q.uid === media.uid && mode === 'youtube') {
                yt.load(q);
            } else if (!media || mode !== 'youtube') {
                yt.stop();
            }
        },

        onState(e) {
            yt.state = e.data;
            if (!media || mode !== 'youtube') return;
            if (e.data === YT_PLAYING) {
                loading(false);
                firstPlay();
            } else if (e.data === YT_BUFFERING) {
                loading(true);
            } else if (e.data === YT_PAUSED) {
                loading(false);
            } else if (e.data === YT_ENDED) {
                loading(false);
                ended();
            }
        },

        meta() {
            let duration = 0;
            let live = !!(media && media.live);
            let title = null;
            try {
                duration = yt.player.getDuration() || 0;
                const vd = yt.player.getVideoData() || {};
                if (vd.isLive) live = true;
                title = vd.title || null;
            } catch (e) { /* ignore */ }
            return { duration: live ? 0 : duration, live, title };
        },

        usable() { return !!(yt.player && yt.ready); },
        time() { try { return yt.player.getCurrentTime() || 0; } catch (e) { return 0; } },
        playing() { return yt.state === YT_PLAYING || yt.state === YT_BUFFERING; },
        play() { try { yt.player.playVideo(); } catch (e) { /* ignore */ } },
        pause() { try { yt.player.pauseVideo(); } catch (e) { /* ignore */ } },
        seek(t) { try { yt.player.seekTo(t, true); } catch (e) { /* ignore */ } },

        applyVolume() {
            if (!yt.usable()) return;
            try {
                const v = holdMute ? 0 : Math.round(volume);
                yt.player.setVolume(v);
                if (v > 0) yt.player.unMute(); else yt.player.mute();
            } catch (e) { /* ignore */ }
        },

        stop() {
            yt.queued = null;
            yt.state = -1;
            try {
                if (yt.usable()) yt.player.stopVideo();
            } catch (e) { /* ignore */ }
        },
    };

    // ------------------------------------------------------------------ Twitch

    const tw = {
        player: null,
        isPlaying: false,

        async load(m) {
            tw.destroy();
            try {
                await loadScript('https://player.twitch.tv/js/embed/v1.js');
            } catch (e) {
                fail('tw_api');
                return;
            }
            if (!media || media.uid !== m.uid || !window.Twitch || !window.Twitch.Player) return;

            const host = $('tw');
            const inner = document.createElement('div');
            inner.id = `twInner${m.uid}`;
            host.replaceChildren(inner);

            const opts = {
                width: '100%',
                height: '100%',
                parent: [location.hostname],
                autoplay: true,
                muted: false,
            };
            if (m.channel) {
                opts.channel = m.channel;
            } else {
                const t = Math.max(0, Math.floor(expected()));
                opts.video = `v${m.video}`;
                opts.time = `${Math.floor(t / 3600)}h${Math.floor((t % 3600) / 60)}m${t % 60}s`;
            }

            const P = window.Twitch.Player;
            const p = new P(inner.id, opts);
            tw.player = p;
            p.addEventListener(P.READY, () => {
                if (tw.player === p) tw.applyVolume();
            });
            p.addEventListener(P.PLAYING, () => {
                if (tw.player !== p) return;
                tw.isPlaying = true;
                loading(false);
                tw.applyVolume();
                firstPlay();
            });
            p.addEventListener(P.PAUSE, () => {
                if (tw.player === p) tw.isPlaying = false;
            });
            p.addEventListener(P.ENDED, () => {
                if (tw.player !== p) return;
                tw.isPlaying = false;
                ended();
            });
            if (P.OFFLINE) {
                p.addEventListener(P.OFFLINE, () => {
                    if (tw.player === p) notice('This channel is offline right now');
                });
            }
        },

        meta() {
            let d = 0;
            try { d = tw.player.getDuration() || 0; } catch (e) { /* ignore */ }
            const live = !!(media && media.channel);
            return { duration: live ? 0 : d, live };
        },

        usable() { return !!tw.player; },
        time() { try { return tw.player.getCurrentTime() || 0; } catch (e) { return 0; } },
        playing() { return tw.isPlaying; },
        play() { try { tw.player.play(); } catch (e) { /* ignore */ } },
        pause() { try { tw.player.pause(); } catch (e) { /* ignore */ } },
        seek(t) { try { tw.player.seek(t); } catch (e) { /* ignore */ } },

        applyVolume() {
            if (!tw.player) return;
            try {
                const v = holdMute ? 0 : Math.max(0, Math.min(1, volume / 100));
                tw.player.setVolume(v);
                tw.player.setMuted(v <= 0);
            } catch (e) { /* ignore */ }
        },

        destroy() {
            tw.player = null;
            tw.isPlaying = false;
            $('tw').replaceChildren();
        },
    };

    // ------------------------------------------------------------------ video / audio / HLS files

    const vid = $('video');

    const mm = {
        hls: null,
        uid: null,

        load(m) {
            mm.stop();
            mm.uid = m.uid;
            const src = m.file ? localUrl(m.file) : m.url;
            vid.muted = false;
            mm.applyVolume();

            vid.onloadedmetadata = () => {
                if (mm.uid !== m.uid) return;
                if (!Number.isFinite(vid.duration)) media.live = true;
                if (!media.live) {
                    try {
                        vid.currentTime = Math.max(0, Math.min(expected(), (vid.duration || 1) - 0.5));
                    } catch (e) { /* ignore */ }
                }
                if (desired.playing) mm.play();
            };
            vid.onplaying = () => {
                if (mm.uid !== m.uid) return;
                loading(false);
                firstPlay();
            };
            vid.onwaiting = () => {
                if (mm.uid === m.uid && desired.playing) loading(true);
            };
            vid.onended = () => {
                if (mm.uid === m.uid) ended();
            };
            vid.onerror = () => {
                if (mm.uid === m.uid) fail(`media_${vid.error ? vid.error.code : 0}`);
            };

            if (m.kind === 'hls' && !vid.canPlayType('application/vnd.apple.mpegurl')) {
                loadScript('https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js').then(() => {
                    if (mm.uid !== m.uid) return;
                    const Hls = window.Hls;
                    if (!Hls || !Hls.isSupported()) {
                        fail('media_4');
                        return;
                    }
                    const hls = new Hls({ lowLatencyMode: true });
                    mm.hls = hls;
                    hls.on(Hls.Events.LEVEL_LOADED, (_, data) => {
                        if (data && data.details && data.details.live && media && media.uid === m.uid) media.live = true;
                    });
                    hls.on(Hls.Events.ERROR, (_, data) => {
                        if (data && data.fatal && mm.uid === m.uid) fail('media_hls');
                    });
                    hls.loadSource(src);
                    hls.attachMedia(vid);
                }).catch(() => fail('media_hls'));
            } else {
                vid.src = src;
                vid.load();
            }
        },

        meta() {
            const d = vid.duration;
            const live = !!(media && media.live) || !Number.isFinite(d);
            return { duration: live ? 0 : d, live };
        },

        usable() { return true; },
        time() { return vid.currentTime || 0; },
        playing() { return !vid.paused && !vid.ended; },
        play() {
            const p = vid.play();
            if (p && p.catch) p.catch(() => {});
        },
        pause() { vid.pause(); },
        seek(t) { try { vid.currentTime = t; } catch (e) { /* ignore */ } },
        applyVolume() { vid.volume = holdMute ? 0 : Math.max(0, Math.min(1, volume / 100)); },

        stop() {
            mm.uid = null;
            vid.onloadedmetadata = null;
            vid.onplaying = null;
            vid.onwaiting = null;
            vid.onended = null;
            vid.onerror = null;
            try { vid.pause(); } catch (e) { /* ignore */ }
            if (mm.hls) {
                try { mm.hls.destroy(); } catch (e) { /* ignore */ }
                mm.hls = null;
            }
            vid.removeAttribute('src');
            try { vid.load(); } catch (e) { /* ignore */ }
        },
    };

    // ------------------------------------------------------------------ images

    const img = $('image');

    function loadImage(m) {
        img.onload = () => {
            if (media && media.uid === m.uid) {
                loading(false);
                firstPlay();
            }
        };
        img.onerror = () => {
            if (media && media.uid === m.uid) fail('image');
        };
        img.src = m.file ? localUrl(m.file) : m.url;
    }

    // ------------------------------------------------------------------ playback core

    function engine() {
        if (mode === 'youtube') return yt.usable() ? yt : null;
        if (mode === 'twitch') return tw.usable() ? tw : null;
        if (mode === 'video' || mode === 'audio') return mm;
        return null;
    }

    function applyVolume() {
        yt.applyVolume();
        tw.applyVolume();
        mm.applyVolume();
    }

    function sync() {
        const e = engine();
        if (!e || !media || endedUid === media.uid || errorUid === media.uid) return;
        const isPlaying = e.playing();
        if (desired.playing && !isPlaying) e.play();
        else if (!desired.playing && isPlaying) e.pause();
        if (media.live) return;
        const want = expected();
        if (media.duration && want >= media.duration - 0.5) return; // the server moves on by itself
        if (Math.abs(e.time() - want) > cfg.tolerance) e.seek(want);
    }

    function firstPlay() {
        if (!media || firstPlayUid === media.uid) return;
        firstPlayUid = media.uid;
        if (mode !== 'image') {
            const e = engine();
            const meta = e && e.meta ? e.meta() : {};
            if (meta.live) media.live = true;
            post('meta', { uid: media.uid, duration: meta.duration || 0, live: !!meta.live, title: meta.title || null });
        }
        sync();
        if (holdMute) {
            setTimeout(() => {
                holdMute = false;
                applyVolume();
            }, 400);
        }
        updateBadges();
    }

    function ended() {
        if (!media || endedUid === media.uid) return;
        endedUid = media.uid;
        post('ended', { uid: media.uid });
        updateBadges();
    }

    function stopAll() {
        yt.stop();
        tw.destroy();
        mm.stop();
        img.onload = null;
        img.onerror = null;
        img.removeAttribute('src');
        mode = null;
        loading(false);
        hideNotice();
    }

    function startMedia(m) {
        stopAll();
        media = Object.assign({}, m);
        firstPlayUid = null;
        endedUid = null;
        errorUid = null;
        holdMute = !desired.playing;
        applyVolume();

        switch (media.kind) {
            case 'youtube':
                mode = 'youtube';
                setLayer('ytWrap');
                loading(true);
                yt.load(media);
                break;
            case 'twitch':
                mode = 'twitch';
                setLayer('tw');
                loading(true);
                tw.load(media);
                break;
            case 'video':
            case 'hls':
                mode = 'video';
                setLayer('video');
                loading(true);
                mm.load(media);
                break;
            case 'audio':
                mode = 'audio';
                setLayer('audio');
                fillAudio(media);
                loading(true);
                mm.load(media);
                break;
            case 'image':
                mode = 'image';
                setLayer('image');
                loading(true);
                loadImage(media);
                break;
            default:
                mode = null;
                setLayer('idle');
                notice('Unsupported media');
                break;
        }
        updateBadges();
    }

    // ------------------------------------------------------------------ videoke

    const GRADES = [[95, 'LEGENDARY!'], [88, 'SUPERSTAR'], [80, 'GREAT VOICE'], [70, 'NICE ONE'], [0, 'KEEP SINGING']];
    let scoreUid = null;
    let scoreTimer = null;

    function hideScore() {
        clearInterval(scoreTimer);
        scoreTimer = null;
        $('score').classList.remove('on');
        $('scGrade').classList.remove('on');
    }

    function showScore(sc) {
        const value = Math.max(0, Math.min(100, Math.round(Number(sc.value) || 0)));
        const grade = (GRADES.find((g) => value >= g[0]) || GRADES[GRADES.length - 1])[1];
        clearInterval(scoreTimer);
        $('scSinger').textContent = sc.singer || '';
        $('scSong').textContent = sc.title || '';
        $('scGrade').textContent = grade;
        $('scGrade').classList.remove('on');
        $('scNum').textContent = '0';
        $('score').classList.add('on');
        const started = performance.now();
        scoreTimer = setInterval(() => {
            const t = Math.min(1, (performance.now() - started) / 1900);
            $('scNum').textContent = String(Math.round(value * (1 - Math.pow(1 - t, 3))));
            if (t >= 1) {
                clearInterval(scoreTimer);
                scoreTimer = null;
                $('scGrade').classList.add('on');
            }
        }, 40);
    }

    function renderKaraoke(d) {
        const on = !!d.power && !!d.videoke;
        const m = d.media;
        const singer = on && m ? (m.singer || m.by || '') : '';
        const bar = $('karaoke');
        if (singer) {
            $('kSinger').textContent = singer;
            const nu = d.nextUp;
            $('kNext').textContent = nu ? `UP NEXT  ${nu.singer || ''}${nu.title ? ' - ' + nu.title : ''}` : '';
            bar.classList.add('on');
        } else {
            bar.classList.remove('on');
        }
        $('brandTag').textContent = on ? 'Videoke night - grab the mic' : (cfg.branding.tagline || '');

        const sc = on && d.score;
        if (sc && sc.uid != null) {
            if (scoreUid !== sc.uid) {
                scoreUid = sc.uid;
                showScore(sc);
            }
        } else {
            scoreUid = null;
            hideScore();
        }
    }

    function onState(d) {
        if (d.screen) screenId = d.screen;
        renderKaraoke(d);
        desired.playing = !!d.playing;
        desired.pos = Number(d.position) || 0;
        desired.at = performance.now();

        if (!d.power) {
            stopAll();
            media = null;
            setLayer(null);
            updateBadges();
            return;
        }

        const m = d.media;
        if (!m) {
            if (media || mode) {
                stopAll();
                media = null;
            }
            setLayer('idle');
            updateBadges();
            return;
        }

        if (!media || media.uid !== m.uid) {
            startMedia(m);
            return;
        }

        media.title = m.title;
        media.author = m.author;
        if (m.duration) media.duration = m.duration;
        if (m.live) media.live = true;
        if (endedUid === media.uid && media.duration && desired.pos < media.duration - 2) endedUid = null;
        if (mode === 'audio') fillAudio(media);
        sync();
        updateBadges();
    }

    function blank() {
        screenId = null;
        $('karaoke').classList.remove('on');
        scoreUid = null;
        hideScore();
        stopAll();
        media = null;
        setLayer(null);
        updateBadges();
    }

    function applyInit(d) {
        greeted = true;
        cfg.tolerance = Number(d.tolerance) || 1.5;
        const b = d.branding || {};
        cfg.branding = b;
        $('brandName').textContent = b.name || 'STREETKINGS';
        $('brandAccent').textContent = b.accent || 'TV';
        $('brandTag').textContent = b.tagline || '';
        $('bugMark').textContent = b.mark || '';
        $('bugAccent').textContent = b.accent || 'TV';
        updateBadges();
    }

    // ------------------------------------------------------------------ messages from Lua

    window.addEventListener('message', (ev) => {
        let d = ev.data;
        if (typeof d === 'string') {
            try { d = JSON.parse(d); } catch (e) { return; }
        }
        if (!d || typeof d !== 'object' || d.etv !== 1) return;
        switch (d.type) {
            case 'init':
                applyInit(d);
                break;
            case 'state':
                onState(d);
                break;
            case 'volume':
                volume = Math.max(0, Math.min(100, Number(d.volume) || 0));
                applyVolume();
                break;
            case 'blank':
                blank();
                break;
            case 'resync':
                if (media) {
                    endedUid = null;
                    sync();
                }
                break;
            default:
                break;
        }
    });

    setInterval(sync, 2000);
    setInterval(tickClock, 15000);
    tickClock();

    // say hello until Lua answers with init (covers a slow first callback)
    let hellos = 0;
    function hello() {
        if (greeted || hellos >= 5) return;
        hellos += 1;
        post('ready');
        setTimeout(hello, 2500);
    }

    if (document.readyState === 'complete') hello();
    else window.addEventListener('load', hello);
})();
