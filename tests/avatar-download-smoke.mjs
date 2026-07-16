import assert from 'node:assert/strict';
import test from 'node:test';

import { onRequestPost } from '../functions/api/b2-avatar-download.js';

test('a student can open the private avatar saved on their profile', async () => {
    const originalFetch = globalThis.fetch;
    const avatarUrl = 'b2:uploads/avatars/TEST001/photo.jpg';

    globalThis.fetch = async (input) => {
        const url = new URL(String(input));

        if (url.pathname === '/auth/v1/user') {
            return Response.json({ id: '11111111-1111-4111-8111-111111111111', email: 'student@example.test' });
        }

        if (url.pathname === '/rest/v1/users') {
            const select = url.searchParams.get('select') || '';
            assert.equal(select.includes('avatar_url'), false);
            assert.equal(select.includes('avatarPath'), false);
            if (url.searchParams.get('role') === 'eq.admin') return Response.json([]);
            return Response.json([{
                id: '11111111-1111-4111-8111-111111111111',
                uid: '11111111-1111-4111-8111-111111111111',
                email: 'student@example.test',
                studentNo: 'TEST001',
                username: 'TEST001',
                role: 'student',
                status: 'Active',
                avatarUrl
            }]);
        }

        if (url.hostname === 'api.backblazeb2.com') {
            return Response.json({
                authorizationToken: 'account-token',
                apiInfo: {
                    storageApi: {
                        apiUrl: 'https://api001.backblazeb2.com',
                        downloadUrl: 'https://f001.backblazeb2.com',
                        allowed: {
                            buckets: [{ id: 'bucket-id' }],
                            capabilities: ['shareFiles'],
                            namePrefix: 'uploads/'
                        }
                    }
                }
            });
        }

        if (url.pathname.endsWith('/b2_get_download_authorization')) {
            return Response.json({ authorizationToken: 'download-token' });
        }

        throw new Error('Unexpected request: ' + url);
    };

    try {
        const request = new Request('https://portal.example/api/b2-avatar-download', {
            method: 'POST',
            headers: {
                authorization: 'Bearer student-access-token',
                'content-type': 'application/json'
            },
            body: JSON.stringify({ avatarUrl, studentNo: 'TEST001' })
        });
        const response = await onRequestPost({
            request,
            env: {
                SUPABASE_URL: 'https://project.supabase.co',
                SUPABASE_PUBLISHABLE_KEY: 'public-key',
                SUPABASE_SERVICE_ROLE_KEY: 'service-key',
                B2_KEY_ID: 'key-id',
                B2_APPLICATION_KEY: 'application-key',
                B2_BUCKET_ID: 'bucket-id',
                B2_BUCKET_NAME: 'private-bucket'
            }
        });

        assert.equal(response.status, 200);
        const body = await response.json();
        assert.match(body.url, /^https:\/\/f001\.backblazeb2\.com\/file\/private-bucket\/uploads\/avatars\/TEST001\/photo\.jpg\?Authorization=/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
