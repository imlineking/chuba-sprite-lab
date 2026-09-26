import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanUserName, firstAccountName, effectiveUserName, readUserProfile, saveUserProfile } from "../src/user-profile.mjs";
import { greeting } from "../src/companion-layout.mjs";
test("account greetings use a first name; a custom name wins",()=>{
  assert.equal(firstAccountName("  Dmitriy Demidenko "),"Dmitriy");
  assert.equal(greeting(effectiveUserName({name:""},"Dmitriy Demidenko")),"Привет, Dmitriy! Давай начнём работу.");
  assert.equal(effectiveUserName({name:"Дима"},"Dmitriy Demidenko"),"Дима");
  assert.equal(effectiveUserName({name:""},""),"");
  assert.equal(cleanUserName("<Дима>\u0000"),"Дима");
});
test("first launch, skip and changed name survive reopening",async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"sprite-user-profile-"));
  const file=path.join(directory,"user-profile.json");
  try {
    assert.deepEqual(await readUserProfile(file),{name:"",onboardingCompleted:false});
    await saveUserProfile(file,"");
    assert.deepEqual(await readUserProfile(file),{name:"",onboardingCompleted:true});
    await saveUserProfile(file,"Дмитрий");
    assert.deepEqual(await readUserProfile(file),{name:"Дмитрий",onboardingCompleted:true});
    await saveUserProfile(file,"");
    assert.equal(effectiveUserName(await readUserProfile(file),"Dmitriy Demidenko"),"Dmitriy");
    await assert.rejects(saveUserProfile(file,{name:"wrong"}),/текстом/);
  } finally {
    const resolved=path.resolve(directory);
    assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("sprite-user-profile-"));
    await fs.rm(resolved,{recursive:true,force:true});
  }
});
