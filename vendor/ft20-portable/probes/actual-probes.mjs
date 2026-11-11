import assert from 'node:assert/strict';
import {appendFileSync} from 'node:fs';
const [dist, revision] = process.argv.slice(2);
const load = name => import(new URL(`src/handlers/${name}.js`, new URL(dist + '/', import.meta.url)));
const {runDirectMemoryCompletion} = await load('review-memory-ops');
const {setupBackgroundReview, describeDiagnostics} = await load('background-review');
const {setupSessionFlush} = await load('session-flush');
const {setupCorrectionDetector} = await load('correction-detector');
const {triggerConsolidation} = await load('auto-consolidate');
const output = new URL('../events.jsonl', import.meta.url);
let failed=0;
async function check(name, fn) {
  let row={at:new Date().toISOString(),revision,name};
  try { row={...row,pass:true,...await fn()}; }
  catch(e) { failed++; row={...row,pass:false,reason:e.message,actual:e.actual,expected:e.expected}; }
  console.log(JSON.stringify(row)); appendFileSync(output, JSON.stringify(row)+'\n');
}
const primary={provider:'test-provider',id:'primary',api:'test-api',reasoning:false};
const models=[primary,{...primary,id:'fallback'}];
const chain={llmModelOverride:'test-provider/primary',llmFallbackModels:['test-provider/fallback']};
const wrap=operations=>JSON.stringify({operations});
const add={action:'add',target:'memory',content:'BODY-SENTINEL'};
const remove={action:'remove',target:'memory',old_text:'absent'};
const plan=wrap([add,remove]);
const text=(s,stopReason='stop')=>({stopReason,content:[{type:'text',text:s}]});
const hostile='META-SENTINEL https://endpoint.invalid/private /private/PATH-SENTINEL sk-SYNTHETICCREDENT1AL0123456789\n\u001b\u0000'+'x'.repeat(4096);
const secret='sk-SYNTHETICCREDENT1AL0123456789';
const branch=Array.from({length:4},(_,i)=>({type:'message',message:{role:i%2?'assistant':'user',content:'PROMPT-SENTINEL '+i}}));
function fixture({mode='skip', response=text(plan), selected=models, auth, stale=false, child={code:71,stderr:'synthetic child failure'}}={}) {
  const attempts=[],calls=[],notices=[],children=[],handlers=new Map(); let physicalWrites=0;
  const store={getMemoryEntries:()=>['synthetic memory'],getUserEntries:()=>[],getAllFailureEntries:()=>[],
    add:async()=>{calls.push('add'); physicalWrites++; if(mode==='first')throw Error(hostile); return {success:true};},
    remove:async()=>{calls.push('remove'); if(mode==='after'){physicalWrites++;throw Error(hostile);}return {success:false};},
    addFailure:async()=>{calls.push('addFailure');physicalWrites++;return {success:true};},
    applyMutationPlan:async()=>{calls.push('atomic');physicalWrites++;throw Error(hostile);},
    getStorageIdentity:async()=>{calls.push('lock');throw Error('offline lock guard');}};
  const ctx={cwd:process.cwd(),model:selected[0],modelRegistry:{getAll:()=>selected,
    getApiKeyAndHeaders:auth??(async()=>({ok:true,apiKey:'synthetic',headers:{},env:{}})),
    streamSimple:(m,_request,opts)=>{attempts.push(m.id);return {result:async()=> typeof response==='function' ? response(opts) : response};}},
    sessionManager:{getSessionId:()=> 'synthetic',getBranch:()=>branch},ui:{notify:(message,kind)=>{notices.push({message,kind});if(stale)throw Error('stale UI');}}};
  const exec=async()=>{children.push('child');return child;};
  const pi={on:(n,fn)=>handlers.set(n,fn),exec};
  return {ctx,store,pi,exec,attempts,calls,children,notices,handlers,get physicalWrites(){return physicalWrites;}};
}
async function direct(f,options={},deps={}) {
  return runDirectMemoryCompletion(f.ctx,f.store,null,{userPrompt:'PROMPT-SENTINEL',systemPrompt:'synthetic',config:chain,...options},null,null,deps);
}
async function actual(c,f,config=chain) {
  const {pi,ctx,store,handlers}=f;
  const user={message:{role:'user',content:'synthetic correction use safe values'}};
  switch(c) {
    case 'background': {
      let settle; const done=new Promise(r=>{settle=r;});
      setupBackgroundReview(pi,store,null,{...config,reviewEnabled:true,nudgeInterval:1,nudgeToolCalls:1,reviewRecentMessages:0},{deps:{execChildPrompt:f.exec,onReviewSettled:settle}});
      for(let i=0;i<3;i++)await handlers.get('message_end')(user,ctx);
      await handlers.get('turn_end')({message:{role:'assistant',content:[]}},ctx);await done;await handlers.get('session_shutdown')();break;
    }
    case 'compact': case 'shutdown':
      setupSessionFlush(pi,store,null,{...config,flushOnCompact:true,flushOnShutdown:true,flushMinTurns:1});
      await handlers.get('message_end')(user,ctx);
      await handlers.get(c==='compact'?'session_before_compact':'session_shutdown')({reason:'exit'},ctx);break;
    case 'correction':
      setupCorrectionDetector(pi,store,null,{...config,correctionDetection:true,correctionStrongPatterns:['^synthetic correction'],correctionNegativePatterns:[]});
      await handlers.get('message_end')(user,ctx); await handlers.get('turn_end')({},ctx);break;
    case 'consolidation': return triggerConsolidation(pi,store,'memory',undefined,5000,'memory',config,ctx);
    default: throw Error('bad caller');
  }
  return f.notices.find(n=>n.kind==='warning')?.message;
}
function observation(f){return {attempts:f.attempts.length,calls:f.calls,children:f.children.length,physicalWrites:f.physicalWrites};}
function redact(outputs){ for(const s of outputs){for(const marker of ['META-SENTINEL','PATH-SENTINEL','endpoint.invalid','BODY-SENTINEL','PROMPT-SENTINEL',secret,'\u001b','\u0000','\n'])assert.ok(!s.includes(marker),`leaked ${JSON.stringify(marker)}`);}}
const cases=[['skip',1,0,['add','remove']],['after',1,1,['add','remove']],['first',0,1,['add']],['atomic',0,2,['atomic']]];
for(const [mode,known,unknown,calls] of cases)await check(`R1 direct ${mode}`,async()=>{
  const f=fixture({mode});const result=await direct(f,{requireAtomicShrink:mode==='atomic'});
  assert.deepEqual({attempts:f.attempts.length,calls:f.calls,children:f.children.length},{attempts:1,calls,children:0});
  assert.equal(result.terminalPartial,true);assert.equal(result.ok,false);assert.equal(result.fallbackReason,'partial_apply');assert.equal(result.appliedCount,known);assert.equal(result.unknownMutationCount??0,unknown);redact([JSON.stringify(result)]);
  return {...observation(f),known,unknown};
});
for(const caller of ['background','compact','shutdown','correction','consolidation'])for(const [mode,known,unknown,calls] of caller==='consolidation'?cases.slice(-1):cases.slice(0,3))for(const stale of caller==='consolidation'?[false]:[false,true])await check(`R1 actual ${caller} ${mode} stale=${stale}`,async()=>{
  const f=fixture({mode,stale});const value=await actual(caller,f);
  assert.deepEqual({attempts:f.attempts.length,calls:f.calls,children:f.children.length},{attempts:1,calls,children:0});
  const warning=caller==='consolidation'?value.error:value;
  if(caller==='consolidation')assert.equal(value.consolidated,false);
  assert.match(warning,new RegExp(`${known} confirmed operation`));if(unknown)assert.match(warning,new RegExp(`up to ${unknown} additional mutation`));else assert.doesNotMatch(warning,/unknown outcome/);
  redact([warning]);return {...observation(f),known,unknown};
});
await check('R1 actual background saved, stale UI',async()=>{const f=fixture({response:text(wrap([add])),stale:true});await actual('background',f);assert.deepEqual(observation(f),{attempts:1,calls:['add'],children:0,physicalWrites:1});return observation(f);});
// Three possible error ingress paths: model response, registry auth result, child result.
for (const kind of ['stop','provider','id','plausible-id','response-error','auth-error','child-error','child-stdout'])await check(`R2 direct plus actual background ${kind}`,async()=>{
  const m={...primary}; if(kind==='provider'||kind==='id')m[kind]=hostile;if(kind==='plausible-id')m.id=secret;
  const opts={selected:[m],response:text('BODY-SENTINEL '+hostile,kind==='stop'?hostile:'stop')};
  if(kind==='response-error')opts.response={...opts.response,stopReason:'error',errorMessage:hostile};
  if(kind==='auth-error')opts.auth=async()=>({ok:false,error:hostile});
  if(kind==='child-error')opts.child={code:71,stderr:hostile};
  if(kind==='child-stdout')opts.child={code:71,stdout:'BODY-SENTINEL PROMPT-SENTINEL '+hostile};
  const f=fixture(opts), result=await direct(f,{config:{}});
  const diag=describeDiagnostics(result.diagnostics);
  if(kind==='stop')assert.equal(result.diagnostics.stopReason,'unknown');
  if(['provider','id','plausible-id'].includes(kind))assert.equal(result.diagnostics.model,'redacted');
  redact([JSON.stringify(result),diag]);assert.ok(diag.length<=512);
  const g=fixture(opts);const warning=await actual('background',g,{});assert.ok(warning);assert.equal(g.children.length,1);assert.deepEqual(g.calls,[]);assert.ok(warning.length<800);
  redact([warning]);return {diagnosticChars:diag.length,warningChars:warning.length,...observation(g)};
});
await check('R2 actual consolidation empty response',async()=>{const f=fixture({selected:[{...primary,id:secret}],response:text('')});const value=await actual('consolidation',f,{});assert.equal(value.consolidated,false);assert.deepEqual(observation(f),{attempts:1,calls:[],children:0,physicalWrites:0});redact([value.error]);return observation(f);});
await check('R2 thinking provider notice',async()=>{const notices=[];const f=fixture({selected:[{...primary,provider:hostile,id:secret}],response:{stopReason:'stop',content:[{type:'thinking',thinking:'BODY-SENTINEL'}]}});const result=await direct(f,{config:{}},{providerNoticeState:{logged:false},onProviderNotice:m=>notices.push(m)});assert.equal(notices.length,1);redact([JSON.stringify(result),...notices]);assert.match(notices[0],/redacted/);return {notices:1};});
console.log(JSON.stringify({revision,failed}));process.exitCode=failed?1:0;
