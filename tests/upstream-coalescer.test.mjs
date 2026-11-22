import test from "node:test";
import assert from "node:assert/strict";
import {coalesceResponse} from "../upstream-coalescer.js";

test("identical concurrent requests share one upstream load and independent response bodies",async()=>{
 let calls=0;
 const loader=async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,10));return new Response(JSON.stringify({calls}),{status:200,headers:{"Content-Type":"application/json","Cache-Control":"public, max-age=20"}});};
 const results=await Promise.all(Array.from({length:20},(_,i)=>coalesceResponse("https://worker.test/api/fixtures?date=2026-11-22",loader,{"Access-Control-Allow-Origin":i%2?"https://app.test":"https://dash.test"})));
 assert.equal(calls,1);
 const bodies=await Promise.all(results.map(r=>r.json()));
 assert.ok(bodies.every(body=>body.calls===1));
 assert.equal(results[0].headers.get("Access-Control-Allow-Origin"),"https://dash.test");
 assert.equal(results[1].headers.get("Access-Control-Allow-Origin"),"https://app.test");
});

test("different URLs are not coalesced",async()=>{
 let calls=0;
 const loader=async()=>{calls++;return new Response("ok");};
 const results=await Promise.all([coalesceResponse("a",loader),coalesceResponse("b",loader)]);
 assert.equal(calls,2);
 assert.deepEqual(await Promise.all(results.map(r=>r.text())),["ok","ok"]);
});

test("failed upstream work is removed and a later request can retry",async()=>{
 let calls=0;
 await assert.rejects(coalesceResponse("retry-key",async()=>{calls++;throw new Error("upstream failed");}),/upstream failed/);
 const response=await coalesceResponse("retry-key",async()=>{calls++;return new Response("recovered");});
 assert.equal(calls,2);
 assert.equal(await response.text(),"recovered");
});

test("non-success responses are shared but not retained after completion",async()=>{
 let calls=0;
 const loader=async()=>{calls++;return new Response("rate limited",{status:429,headers:{"Retry-After":"60"}});};
 const [a,b]=await Promise.all([coalesceResponse("429",loader),coalesceResponse("429",loader)]);
 assert.equal(calls,1);
 assert.equal(a.status,429);assert.equal(b.status,429);
 assert.equal(b.headers.get("Retry-After"),"60");
 await coalesceResponse("429",loader);
 assert.equal(calls,2);
});

test("invalid keys and non-Response loader values fail closed",async()=>{
 await assert.rejects(coalesceResponse("",async()=>new Response("x")),TypeError);
 await assert.rejects(coalesceResponse("bad",async()=>"not a response"),/must return a Response/);
});
