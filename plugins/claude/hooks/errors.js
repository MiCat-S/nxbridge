                                 
export const MODEL_ERROR_FALLBACK = 'call failed (unmapped nxbridge error); tell user (originating window)';
export const modelMessage = error => error?.model_message || MODEL_ERROR_FALLBACK;
export const referenceDeny = reason => `nxref not expanded: ${reason}; fix ref or inline text`;
