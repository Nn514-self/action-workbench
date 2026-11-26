import { permits, type Action, type Actor } from './module.js';
import { createRequire } from 'node:module';
const version:string=createRequire(import.meta.url)('../package.json').version;

type Shape = Record<string, unknown>;
export interface ApiDocument {
  openapi: '3.1.1'; info: {title:string; version:string; description:string};
  paths: Record<string, Record<string, Shape>>; components: {schemas: Record<string,Shape>};
}
const id = {type:'string',format:'uuid'}, text = {type:'string'};
const ref = (name: string) => ({$ref:`#/components/schemas/${name}`});
const object = (properties: Shape, required = Object.keys(properties)) => ({type:'object',properties,required,additionalProperties:false});
const array = (items: Shape) => ({type:'array',items});
const json = (schema: Shape) => ({'application/json':{schema}});
const response = (description: string, schema: Shape) => ({description,content:json(schema)});
const problem = object({code:text,message:text});
const error = response('Request rejected or command did not succeed',{oneOf:[object({error:problem}),ref('CommandError'),ref('Closed')]});
const success = (action:Shape, result:Shape) => object({id,action,status:{const:'succeeded'},result});
const proposal = (action:Shape, input:Shape) => object({id,action,status:{const:'pending'},input,expiresAt:{type:'integer'}});
const states = {oneOf:['Success','Proposal','Running','Closed','CommandError'].map(ref)};
const page = {type:'integer',minimum:1,maximum:100,default:20};
const parameter = (name:string, location:string, schema:Shape, required=false) => ({name,in:location,required,schema});
const escape = (key:string) => encodeURIComponent(key.replace(/~/g,'~0').replace(/\//g,'~1'));

// Zod emits local fragments (including '#' for recursion). Anchor the schema as its own JSON Schema resource.
function component(schema: Action['inputSchema'], name: string): Shape {
  return {$id:`urn:action-workbench:${name}`, ...schema};
}
export function describeHttp(actions: ReadonlyMap<string, Action>, actor: Actor): ApiDocument {
  const schemas: Record<string, Shape> = {
    Success:success(text,{}), Proposal:proposal(text,{}), Running:object({id,action:text,status:{const:'running'}}),
    Closed:object({id,action:text,status:{enum:['expired','cancelled']}}),
    CommandError:object({id,action:text,status:{enum:['failed','unknown']},error:object({status:{type:'integer'},...problem.properties})}),
  };
  const paths: ApiDocument['paths'] = {};
  const pathNames=new Map<string,readonly string[]>();
  for (const [name,a] of actions) {
    if (!permits(actor,a,'http')) continue;
    const input=`${name}.input`, output=`${name}.output`;
    schemas[input]=component(a.inputSchema,input); schemas[output]=component(a.outputSchema,output);
    const fieldsInPath=a.pathParameters, pattern=/:([A-Za-z]\w*)/g, template=a.http.path.replace(pattern,':');
    // OpenAPI requires identical URL shapes to use the same placeholders, also across different HTTP verbs.
    const aliases=pathNames.get(template) ?? fieldsInPath; pathNames.set(template,aliases);
    let n=0; const path=a.http.path.replace(pattern,()=>`{${aliases[n++]}}`);
    const fields = Object.keys(a.inputSchema.properties ?? {}), required = new Set(a.inputSchema.required);
    const field = (key:string) => ({$ref:`${ref(input).$ref}/properties/${escape(key)}`});
    const rest = fields.filter(k=>!fieldsInPath.includes(k));
    const parameters = fieldsInPath.map((k,i)=>parameter(aliases[i],'path',field(k),true));
    const responses: Shape = {'200':response('Completed',success({const:name},ref(output))),default:error};
    const op: Shape = {operationId:name,description:a.description,parameters,responses,'x-action-version':a.version,'x-http-confirmation':a.confirmation};
    if (a.http.method==='GET') parameters.push(...rest.map(k=>parameter(k,'query',field(k),required.has(k))));
    else if (rest.length) {
      const keys=rest.filter(k=>required.has(k));
      const body=fieldsInPath.length ? object(Object.fromEntries(rest.map(k=>[k,field(k)])),keys) : ref(input);
      op.requestBody={required:keys.length>0,content:json(body)};
    }
    if (a.kind==='command') {
      parameters.push(parameter('Idempotency-Key','header',{type:'string',pattern:'^[!-~]{1,128}$'}));
      responses['202']=response('Pending confirmation or already running',{oneOf:[proposal({const:name},ref(input)),ref('Running')]});
    }
    (paths[path] ??= {})[a.http.method.toLowerCase()]=op;
  }
  const add=(path:string,method:string,description:string,schema:Shape,extra:Shape={})=>{
    paths[`/_aw/${path}`]={[method]:{description,responses:{'200':response(description,schema),default:error},...extra}};
  };
  add('actions','get','Authorized HTTP actions',array(object({name:text,description:text,kind:{enum:['query','command']},inputSchema:{type:'object'}})));
  add('capabilities','get','Capabilities this user may learn about in chat',array(object({name:text,description:text,mode:{enum:['manual','assistant']}})));
  add('openapi.json','get','This identity-scoped HTTP contract',{type:'object'});
  const entry=object({id,action:text,source:{enum:['http','ai']},status:{const:'pending'},input:{},createdAt:{type:'integer'},expiresAt:{type:'integer'}});
  add('invocations/pending','get','Own pending commands',object({items:array(entry),nextCursor:{type:['string','null']}}),{parameters:[parameter('limit','query',page),parameter('cursor','query',text)]});
  for (const [suffix,method] of [['','get'],['/confirm','post'],['/cancel','post']]) {
    add(`invocations/{id}${suffix}`,method,'Authenticated command receipt',states,{parameters:[parameter('id','path',id,true)],responses:{'200':response('Finished',ref('Success')),'202':response('Unfinished',{oneOf:[ref('Running'),ref('Proposal')]}),default:error}});
  }
  const chat=object({message:{type:'string',minLength:1,maxLength:2000},conversationId:id},['message']);
  add('assistant/messages','post','Optional assistant; 503 when disabled',{}, {requestBody:{required:true,content:json(chat)},responses:{
    '200':response('Reply or question',object({conversationId:id,type:{const:'reply'},text,pending:ref('Proposal')},['conversationId','type','text'])),
    '202':response('Review before confirming',object({conversationId:id,type:{const:'confirmation_required'},invocation:ref('Proposal')})),default:error}});
  return {openapi:'3.1.1',info:{title:'Product API',version,description:'Authenticated by the host. Business routes and schemas are filtered for the requesting identity.'},paths,components:{schemas}};
}
