const CHECK_INTERVAL_MS = 20000;

export function startStudentSessionGuard(supabase, user) {
    const studentNo = user && user.studentNo;
    const sessionToken = user && (user.activeSessionToken || user.sessionToken);
    if (!studentNo || !sessionToken) return { stop: () => {} };

    let stopped = false;
    let checking = false;
    let timer = null;

    async function endLocalSession(message) {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        try { localStorage.removeItem('loggedInUser'); } catch (error) {}
        try { alert(message || 'Your account was opened on another device. Please log in again.'); } catch (error) {}
        window.location.href = 'index.html';
    }

    async function checkSession() {
        if (stopped || checking || document.visibilityState === 'hidden') return;
        checking = true;
        try {
            const { data, error } = await supabase.rpc('validate_student_session', {
                p_student_no: studentNo,
                p_session_token: sessionToken
            });
            if (error) {
                // If SQL is not installed yet, do not interrupt the student.
                if (String(error.message || '').toLowerCase().includes('validate_student_session')) return;
                return;
            }
            if (data === false) await endLocalSession('For security, this account was logged in on another device. This session has been signed out.');
        } catch (error) {
            // Network hiccups should not kick students out.
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
