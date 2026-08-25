(() => {
    const pageName = decodeURIComponent(location.pathname.split('/').pop() || '').toLowerCase();
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

    function pageFromLink(link) {
        const href = link.getAttribute('href');
        if (!href || href === '#' || href.startsWith('javascript:')) return '';
        try { return decodeURIComponent(new URL(href, location.href).pathname.split('/').pop() || '').toLowerCase(); }
        catch (_) { return ''; }
    }

    function centerItem(container, item, smooth = false) {
        if (!container || !item || container.scrollWidth <= container.clientWidth + 2) return;
        const target = item.offsetLeft - ((container.clientWidth - item.offsetWidth) / 2);
        container.scrollTo({ left: Math.max(0, target), behavior: smooth && !reducedMotion ? 'smooth' : 'auto' });
    }

    function enhanceBottomNav(nav) {
        if (nav.dataset.navEnhanced === '1') return;
        const list = nav.querySelector('ul');
        const links = [...nav.querySelectorAll('a')];
        if (!list || !links.length) return;

        nav.dataset.navEnhanced = '1';
        nav.setAttribute('aria-label', nav.getAttribute('aria-label') || 'Primary mobile navigation');

        const matchingLink = links.find(link => pageFromLink(link) === pageName);
        let activeLink = matchingLink || links.find(link => link.classList.contains('active'));
        if (matchingLink) {
            links.forEach(link => link.classList.toggle('active', link === matchingLink));
            activeLink = matchingLink;
        }
        links.forEach(link => {
            if (link === activeLink) link.setAttribute('aria-current', 'page');
            else link.removeAttribute('aria-current');
            link.addEventListener('focus', () => centerItem(list, link.parentElement, true));
        });

        const centerActive = smooth => {
            if (innerWidth <= 760 && activeLink) centerItem(list, activeLink.parentElement, smooth);
        };
        requestAnimationFrame(() => requestAnimationFrame(() => centerActive(false)));

        let resizeTimer;
        addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => centerActive(false), 100);
        }, { passive: true });
    }

    function enhanceTabletSidebar() {
        const list = document.querySelector('.sidebar .nav-menu');
        const active = list?.querySelector('a.active');
        if (!list || !active) return;
        requestAnimationFrame(() => {
            if (innerWidth > 760 && innerWidth <= 900) centerItem(list, active.parentElement, false);
        });
    }

    function initializeNavigation() {
        document.querySelectorAll('.mobile-nav-bar').forEach(enhanceBottomNav);
        enhanceTabletSidebar();
        document.documentElement.classList.add('plv-navigation-ready');
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeNavigation, { once: true });
    else initializeNavigation();
})();
