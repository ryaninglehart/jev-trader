import { expect, test } from "bun:test";
import { collectorReportReady } from "../scripts/cloud-startup";
const start=Date.parse("2026-10-17T00:50:00Z");
test("slow replay waits beyond the old minute without checkpointing a previous writer",()=>{
 const old={processId:123,updatedAt:new Date(start-1000).toISOString()};
 expect(collectorReportReady(old,456,start,start+61000)).toBe(false);
 expect(collectorReportReady(old,456,start,start+600000)).toBe(false);
 expect(collectorReportReady({processId:456,updatedAt:new Date(start+600001).toISOString()},456,start,start+600002)).toBe(true);
});
test("PID reuse or malformed timestamps never make an old report ready; waiting is bounded",()=>{
 expect(collectorReportReady({processId:456,updatedAt:new Date(start-1).toISOString()},456,start,start+61000)).toBe(false);
 expect(collectorReportReady({processId:456,updatedAt:"invalid"},456,start,start+61000)).toBe(false);
 expect(()=>collectorReportReady({processId:123,updatedAt:new Date(start+1).toISOString()},456,start,start+900000)).toThrow("startup exceeded");
 expect(collectorReportReady({processId:456,updatedAt:new Date(start).toISOString()},456,start,start+900000)).toBe(true);
});
