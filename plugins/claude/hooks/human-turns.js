                                
                                   
export class HumanTurns {
  pending = new WeakMap();
  latest = new WeakMap();
  turn(context) { return this.latest.get(context); }
  matches(candidate, text) {
    return candidate.text === text || candidate.command && text.includes('<command-name>/' + candidate.command + '</command-name>');
  }
  consume(context, pending, index) {
                                                        
    const after = pending[index].after;
    const remaining = pending.filter((value, position) => position > index || value.after !== after);
    if (remaining.length) this.pending.set(context, remaining); else this.pending.delete(context);
  }
  submit(context, event, result, before) {
    if (result?.drop !== undefined || typeof result?.text !== 'string') return false;
    const current = this.latest.get(context);
                                               
    const candidate = { after: event.turnId ?? before?.turnId, text: result.text, command: event.command?.name };
    const pending = this.pending.get(context) ?? [];
    pending.push(candidate);
    if (current && current !== before && current.turnId !== candidate.after && this.matches(candidate, current.text)) {
      this.consume(context, pending, pending.length - 1);
      return { turnId: current.turnId };
    }
                                        
    if (pending.length > 64) pending.splice(0, pending.length - 64);
    this.pending.set(context, pending);
    return false;
  }
  start(context, event) {
    this.latest.set(context, { turnId: event.turnId, text: event.text ?? '' });
    const pending = this.pending.get(context);
    const index = pending?.findIndex(value => value.after !== event.turnId && this.matches(value, event.text ?? '')) ?? -1;
    if (index < 0) return false;
    this.consume(context, pending, index);
    return true;
  }
  current(context, turnId) {
    const current = this.latest.get(context);
    return !current || current.turnId === turnId;
  }
  clear(context) { this.pending.delete(context); this.latest.delete(context); }
}
