const CHECK_INTERVAL_MS = 20000;

export function startAdminSessionGuard(supabase, user) {
    const profileId = user && user.id;
    const sessionToken = user && (user.activeSessionToken || user.sessionToken);
    if (!profileId || !sessionToken) return { stop: () => {} };

    let stopped = false;
    let checking = false;
    let timer = null;

    async function endLocalSession(message) {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        try { localStorage.removeItem('loggedInUser'); } catch (error) {}
        try { await supabase.auth.signOut(); } catch (error) {}
        try { alert(message || 'Your admin account was opened on another device. Please log in again.'); } catch (error) {}
        window.location.href = 'index.html';
    }

    async function checkSession() {
        if (stopped || checking || document.visibilityState === 'hidden') return;
        checking = true;
        try {
            const { data, error } = await supabase.rpc('validate_admin_session', {
                p_profile_id: String(profileId),
                p_session_token: sessionToken
            });
            if (error) {
                if (String(error.message || '').toLowerCase().includes('validate_admin_session')) return;
                return;
            }
            if (data === false) await endLocalSession('For security, this admin account was logged in on another device. This session has been signed out.');
        } catch (error) {
        } finally {
            checking = false;
        }
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkSession();
    });
    window.addEventListener('focus', checkSession);
    timer = setInterval(checkSession, CHECK_INTERVAL_MS);
    checkSession();

    return {
        stop() {
            stopped = true;
            clearInterval(timer);
        }
    };
}
