const ACTIVE_LIMIT_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;
const ACTIVITY_DEBOUNCE_MS = 15 * 1000;
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'click', 'touchstart', 'scroll'];

export function startStudentPresence(supabase, user) {
    const studentNo = user && user.studentNo;
    if (!studentNo) {
        return { stop: async () => {} };
    }

    let lastActivityAt = Date.now();
    let heartbeatTimer = null;
    let idleTimer = null;
    let debounceTimer = null;
    let online = false;
    let stopped = false;

    async function setPresence(isOnline) {
        if (stopped && isOnline) return;
        try {
            const { error } = await supabase.rpc('set_student_online', {
                p_student_no: studentNo,
                p_is_online: isOnline
            });
            if (!error) online = isOnline;
        } catch (error) {
            // Presence should never interrupt the student page.
        }
    }

    function sendOffline() {
        setPresence(false);
    }

    function isRecentlyActive() {
        return Date.now() - lastActivityAt < ACTIVE_LIMIT_MS;
    }

    async function ping() {
        if (document.visibilityState === 'hidden' || !isRecentlyActive()) {
            await setPresence(false);
            return;
        }
        await setPresence(true);
    }

    function resetIdleTimer() {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            if (!isRecentlyActive()) sendOffline();
        }, ACTIVE_LIMIT_MS + 1000);
    }

    function noteActivity() {
        if (stopped || document.visibilityState === 'hidden') return;
        lastActivityAt = Date.now();
        resetIdleTimer();

        if (!online) {
            ping();
            return;
        }

        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(ping, ACTIVITY_DEBOUNCE_MS);
    }

    function handleVisibilityChange() {
        if (document.visibilityState === 'hidden') {
            sendOffline();
            return;
        }
        lastActivityAt = Date.now();
        resetIdleTimer();
        ping();
    }

    ACTIVITY_EVENTS.forEach(eventName => {
        document.addEventListener(eventName, noteActivity, { passive: true });
    });
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', noteActivity);
    window.addEventListener('pagehide', sendOffline);
    window.addEventListener('beforeunload', sendOffline);

    resetIdleTimer();
    ping();
    heartbeatTimer = setInterval(ping, HEARTBEAT_MS);

    return {
        async stop() {
            stopped = true;
            clearInterval(heartbeatTimer);
            clearTimeout(idleTimer);
            clearTimeout(debounceTimer);
            ACTIVITY_EVENTS.forEach(eventName => {
                document.removeEventListener(eventName, noteActivity);
            });
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            window.removeEventListener('focus', noteActivity);
            window.removeEventListener('pagehide', sendOffline);
            window.removeEventListener('beforeunload', sendOffline);
            await setPresence(false);
        }
    };
}
