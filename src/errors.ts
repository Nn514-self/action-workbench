/** Throw only for a known business rejection; do not put credentials or database errors in the public message. */
export class ActionError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
export const unavailable = () => new ActionError(404, 'NOT_FOUND', '此动作或记录不可用。');
export const proposalChanged = () => new ActionError(409,'PROPOSAL_CHANGED','原提议已被处理或过期。请查看实际回执；不会另建提议。');
