/** Status labels are descriptive, not a promise that all chips belong to one subject.
 * Recitation balances are shared between subjects and student transfers.
 */
export function getConversionStatus({balance=0,rate=3,converted=0,headroom=Infinity}={}) {
  const available=Math.max(0,Math.floor(Number(balance)||0));
  const unit=Number(rate);
  const previous=Math.max(0,Number(converted)||0);
  const room=Math.max(0,Math.floor(Number(headroom)));
  const eligible=Number.isInteger(unit)&&unit>0 ? Math.min(Math.floor(available/unit),room) : 0;
  if (eligible>0) return {kind:'pending',label:previous>0?'More to convert':'Not converted',convertible:eligible,description:`${eligible} exam point${eligible===1?'':'s'} ready for manual conversion`};
  if (previous>0) return {kind:'converted',label:'Converted',convertible:0,description:available>0?`${available} chips remain in the shared wallet`:'Previously converted to exam points'};
  if (available>0 && room>0) return {kind:'pending',label:'Not converted',convertible:0,description:`${Math.max(0,unit-available)} more chip${unit-available===1?'':'s'} needed for 1 exam point`};
  if (room===0) return {kind:'neutral',label:'Exam at maximum',convertible:0,description:'No exam points can be added'};
  return {kind:'neutral',label:'No chips yet',convertible:0,description:'Nothing to convert yet'};
}
