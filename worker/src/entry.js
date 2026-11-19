import { DurableObject } from 'cloudflare:workers';
import worker, { Quotas as QuotaLogic, UploadSession as SessionLogic } from './index.js';

export default worker;
// The Worker entry exports handlers only. Testable helpers live in index.js.
export class Quotas extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.logic = new QuotaLogic(ctx); }
  fetch(request) { return this.logic.fetch(request); }
  alarm() { return this.logic.alarm(); }
}
export class UploadSession extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.logic = new SessionLogic(ctx); }
  fetch(request) { return this.logic.fetch(request); }
  alarm() { return this.logic.alarm(); }
}
