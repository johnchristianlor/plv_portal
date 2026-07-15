# Assessment Security Test Matrix

Status legend:

- **Automated:** covered by `tests/assessment-security-smoke.mjs` or `tests/validate-assessment-security.mjs`.
- **Code-validated:** implementation and static contracts are checked, but the browser event still requires manual verification.
- **Manual browser:** must be tested in supported desktop/mobile browsers.
- **Provider required:** needs a real external secure-browser integration.

1. **Student starts a Standard assessment** — Automated. Start, server question assignment, scoring, and protected submission fields are covered.
2. **Student starts a Monitored assessment** — Automated. Public mode configuration and start flow are covered.
3. **Student starts a Strict assessment** — Automated. Strict mode, deadline, session, and question safety are covered.
4. **Student manually requests an assessment assigned to another section** — Automated. The server returns `403`.
5. **Student attempts to start a submitted assessment** — Automated through maximum-attempt enforcement.
6. **Student attempts to exceed maximum attempts** — Automated.
7. **Student refreshes and restores the same stable questions** — Automated at API/session level; also perform Manual browser refresh.
8. **Student changes tabs once** — Code-validated for canonical event and policy; Manual browser.
9. **Visibility change and window blur fire together but create one incident** — Code-validated by focus-transition grouping and delayed blur suppression; Manual browser.
10. **Student repeatedly changes tabs** — Code-validated for cooldown, count, weight, and threshold; Manual browser.
11. **Student exits and restores fullscreen** — Code-validated; Manual browser because fullscreen APIs differ.
12. **Fullscreen entry during startup does not create an anomaly** — Code-validated through inactive state and suppression; Manual browser.
13. **Student copies, cuts, pastes, or right-clicks** — Code-validated; Manual browser.
14. **Student uses a restricted shortcut** — Code-validated; Manual browser. Print Screen is treated only as a shortcut signal.
15. **Student loses internet briefly** — Automated for no unfair auto-submit and Code-validated for offline state; Manual browser.
16. **Student remains offline past the grace period** — Code-validated; Manual browser with network throttling.
17. **Offline answers synchronize after reconnection** — Code-validated through IndexedDB and autosave flow; Manual browser.
18. **Pending incidents synchronize without duplication** — Automated, including bounded batch upload and client event IDs.
19. **Student opens the same exam in another tab** — Automated at server preflight/start; Manual browser for BroadcastChannel UX.
20. **Student opens the same exam on another device** — Automated using separate privacy-conscious device/session identifiers; perform Manual physical-device verification.
21. **A stale session is safely recovered** — Code-validated; Manual browser by exceeding heartbeat grace and recovering.
22. **An old replaced session attempts to save** — Code-validated by session-token hash, active-session authority, and `SESSION_REPLACED`; Manual multi-window verification.
23. **Supabase access token expires during a long exam** — Code-validated for fresh session retrieval and one 401 refresh retry; Manual staging test with real Supabase.
24. **Client device clock is changed** — Automated indirectly through server deadline enforcement; Manual browser clock change recommended.
25. **Client timer is modified or disabled** — Automated through server deadline finalization; Manual DevTools simulation recommended.
26. **Student attempts to submit after the deadline** — Automated.
27. **Server finalizes an expired attempt using saved answers** — Automated and scored from the latest server save.
28. **Automatic submission occurs at the configured violation threshold** — Automated.
29. **A low-severity connection event does not unfairly auto-submit** — Automated.
30. **Mobile orientation changes without creating an incident** — Code-validated because resize/orientation events are not incident sources; Manual Android/iPhone.
31. **Mobile keyboard opens without creating an incident** — Code-validated because viewport resize is not an incident source; Manual Android/iPhone.
32. **Required camera permission is denied** — Code-validated with a dedicated preflight check before attempt creation; Manual browser permission test.
33. **Required media stream stops during the exam** — Code-validated using track `ended` events; Manual camera/microphone/screen-share test.
34. **Secure-browser verification is required but unavailable** — Automated. Preflight is unavailable and start is blocked.
35. **Administrator reviews an attempt timeline** — Automated.
36. **Administrator marks an incident as a false positive** — Automated and persisted.
37. **Student attempts to modify score, deadline, warning count, or ownership** — Automated/static. Student-supplied privileged fields are ignored and ownership is server-derived.
38. **Student API responses contain no answer keys or private security settings** — Automated/static.
39. **Existing older assessments load with legacy security settings** — Automated.
40. **Existing anomaly records display using legacy aliases** — Code-validated by shared alias maps; verify with one copied production record in staging.

## Minimum staging acceptance before production

The automated tests must pass, then complete every item marked Manual browser on at least:

- Chrome or Edge on Windows;
- Safari on iPhone;
- Chrome on Android;
- one secondary desktop browser used by students.

Strict mode should not be enabled for a high-stakes assessment until fullscreen, reconnection, refresh recovery, mobile suspension, and warning behavior have been observed in the actual deployment.

Secure Browser Ready mode must remain blocked until a real approved provider returns a server-verifiable proof. User-agent matching is not an acceptance test.
