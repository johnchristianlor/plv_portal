import assert from 'node:assert/strict';
import test from 'node:test';

import { createStudentDataCache, STUDENT_DATA_FIELDS } from '../public/student-data.js';

function memoryStorage() {
    const values = new Map();
    return {
        getItem: key => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: key => values.delete(key)
    };
}

test('student data cache deduplicates concurrent reads and honors its short TTL', async () => {
    let now = 1_000;
    let calls = 0;
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const cache = createStudentDataCache({ storage: memoryStorage(), now: () => now, ttlMs: 100 });
    const loader = async () => { calls += 1; await pending; return [{ id: 1 }]; };

    const first = cache.get('enrollments:TEST001', loader);
    const second = cache.get('enrollments:TEST001', loader, { force: true });
    release();
    assert.deepEqual(await first, [{ id: 1 }]);
    assert.deepEqual(await second, [{ id: 1 }]);
    assert.equal(calls, 1, 'a forced concurrent caller should share the active request');

    assert.deepEqual(await cache.get('enrollments:TEST001', async () => { calls += 1; return []; }), [{ id: 1 }]);
    assert.equal(calls, 1, 'a fresh session cache entry should avoid another request');

    now += 101;
    assert.deepEqual(await cache.get('enrollments:TEST001', async () => { calls += 1; return [{ id: 2 }]; }), [{ id: 2 }]);
    assert.equal(calls, 2, 'an expired entry should be refreshed');
});

test('student cache field lists stay explicit and exclude wildcard selects', () => {
    for (const fields of Object.values(STUDENT_DATA_FIELDS)) {
        assert.notEqual(fields, '*');
        assert.equal(fields.includes('password'), false);
        assert.equal(fields.includes('activeSessionToken'), false);
    }
});
