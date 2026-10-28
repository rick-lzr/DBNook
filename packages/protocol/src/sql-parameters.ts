import {z} from 'zod';
export const SqlParameterValueSchema=z.object({key:z.string().min(1).max(300),type:z.enum(['auto','string','number','date','identifier']),value:z.string().max(1_000_000).nullable()}).strict();
export const SqlParameterValuesSchema=z.array(SqlParameterValueSchema).max(256);
export type SqlParameterValue=z.infer<typeof SqlParameterValueSchema>;
/** options is opaque fourth-field metadata: the reference parameter form does not consume it. */
export interface SqlParameter {key:string;name:string;type:SqlParameterValue['type'];defaultValue?:string;options?:string;occurrences:number;}
export interface SqlParameterForm {sql:string;parameters:SqlParameter[];values:SqlParameterValue[];deferred?:boolean;delimiter?:string;}
