import {z} from 'zod';
import {TableStructureSchema} from './ddl.js';
export const DefinitionRefSchema=z.object({kind:z.enum(['table','view','trigger','function','procedure','materialized-view']),id:z.string().min(1).max(1000),schema:z.string().max(255).optional(),name:z.string().min(1).max(255),label:z.string().max(4000).optional(),table:z.string().max(1000).optional()}).strict();
export type DefinitionRef=z.infer<typeof DefinitionRefSchema>;
export const DefinitionSnapshotSchema=z.object({profileId:z.string().min(1).max(100),driver:z.enum(['sqlite','postgresql','mysql','mariadb']),ref:DefinitionRefSchema,sql:z.string().max(4*1024*1024),rawSql:z.string().max(4*1024*1024),identity:z.string().max(8*1024*1024),revision:z.string().regex(/^[a-f0-9]{64}$/),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),editable:z.boolean(),notes:z.array(z.string()),extras:z.array(z.object({name:z.string(),sql:z.string()}).strict()),modeRaw:z.string().optional(),triggerState:z.string().optional(),tableStructure:TableStructureSchema.optional()}).strict();
export type DefinitionSnapshot=z.infer<typeof DefinitionSnapshotSchema>;
export interface DefinitionPreview {token:string;profileId:string;target:string;kind:DefinitionRef['kind'];policy:'transactional'|'implicit-commit'|'sqlite-rebuild';steps:string[];warnings:string[];expiresAt:string;sql?:string;}
export type DefinitionPreviewResult={kind:'conflict';current:DefinitionSnapshot|null;baseline:DefinitionSnapshot}|{kind:'preview';preview:DefinitionPreview};
export interface DefinitionReport {status:'succeeded'|'failed'|'cancelled'|'unknown';completed:number;committed:boolean;rolledBack:boolean;objectExists?:boolean;error?:string;snapshot?:DefinitionSnapshot;warnings:string[];}
