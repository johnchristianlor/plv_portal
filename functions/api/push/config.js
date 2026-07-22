import { envValue, json } from '../../_shared/push.js';

export function onRequestGet({ env }) {
  const appId = envValue(env, 'ONESIGNAL_APP_ID');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(appId)) {
    return json({ configured: false }, 503);
  }
  return new Response(JSON.stringify({ configured: true, appId }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
}
