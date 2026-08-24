const VENDORS = Object.freeze({
    xlsx: {
        global: 'XLSX',
        src: 'https://cdn.sheetjs.com/xlsx-0.20.0/package/dist/xlsx.full.min.js'
    },
    papa: {
        global: 'Papa',
        src: 'https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js'
    },
    qrcode: {
        global: 'QRCode',
        src: 'https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js'
    },
    jsqr: {
        global: 'jsQR',
        src: 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js'
    }
});

const pending = new Map();

export function loadVendor(name) {
    const vendor = VENDORS[name];
    if (!vendor) return Promise.reject(new Error(`Unknown vendor library: ${name}`));
    if (globalThis[vendor.global]) return Promise.resolve(globalThis[vendor.global]);
    if (pending.has(name)) return pending.get(name);

    const request = new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[data-plv-vendor="${name}"]`);
        const script = existing || document.createElement('script');
        const done = () => {
            if (globalThis[vendor.global]) resolve(globalThis[vendor.global]);
            else reject(new Error(`${name} loaded without exposing ${vendor.global}.`));
        };
        script.addEventListener('load', done, { once: true });
        script.addEventListener('error', () => reject(new Error(`Could not load ${name}.`)), { once: true });
        if (!existing) {
            script.src = vendor.src;
            script.async = true;
            script.dataset.plvVendor = name;
            script.referrerPolicy = 'no-referrer';
            document.head.appendChild(script);
        }
    }).catch(error => {
        pending.delete(name);
        throw error;
    });

    pending.set(name, request);
    return request;
}
