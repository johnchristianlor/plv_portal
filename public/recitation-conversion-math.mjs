/** Pure client preview; the Supabase transaction is the authoritative decision. */
export function planRecitationConversion({balance=0,rate=3,headroom=0}={}) {
  const safeBalance = Number.isSafeInteger(Number(balance)) && Number(balance)>0 ? Number(balance) : 0;
  const safeRate = Number.isSafeInteger(Number(rate)) && Number(rate)>0 ? Number(rate) : 0;
  const safeRoom = Number.isSafeInteger(Number(headroom)) && Number(headroom)>0 ? Number(headroom) : 0;
  const points = safeRate ? Math.min(Math.floor(safeBalance/safeRate),safeRoom,100000) : 0;
  const spent = points*safeRate;
  return {points,spent,retained:safeBalance-spent,eligible:points>0};
}
