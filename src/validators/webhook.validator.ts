import { z } from 'zod';

export const jotformBodySchema = z.object({
  formID:       z.string().min(1, 'formID is required'),
  submissionID: z.string().min(1, 'submissionID is required'),
  formTitle:    z.string().optional(),
  ip:           z.string().optional(),
  rawRequest:   z.string().optional(),
  pretty:       z.string().optional(),
}).passthrough();