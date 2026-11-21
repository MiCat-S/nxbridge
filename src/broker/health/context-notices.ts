import type { ContextRotation, Peer } from '../../types.js';

export function contextNotice(rotation:ContextRotation,partner:Peer):string{
  const name=partner.name||partner.host;
  const base=rotation.reason==='reset'?`partner ${name} cleared its context (${partner.host==='claude'?'/clear':'/new'}); it no longer recalls earlier msgs -> restate needed context; nxref:msg to old msgs still works`
    :rotation.reason==='switch'?`partner ${name} switched to another conversation in same window; it may lack recent context -> restate if needed`
    :rotation.reason==='fork'?`partner ${name} branched its conversation in same window; context before branch point kept`
    :`partner ${name} conversation changed (reason unknown); assume earlier context lost`;
  return base+(rotation.unanswered.length?' | seen, unanswered: '+rotation.unanswered.join(', '):'')+(rotation.uncertain.length?' | delivery unconfirmed: '+rotation.uncertain.join(', '):'')+(rotation.cancelledQuestions??[]).map(id=>' | your q '+id+' canceled: its context changed').join('');
}
