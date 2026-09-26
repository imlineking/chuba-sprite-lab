import fs from "node:fs/promises";
import path from "node:path";

export function cleanUserName(value) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0,80) : "";
}
export function firstAccountName(value) {
  return cleanUserName(value).split(/\s+/)[0] || "";
}
export function effectiveUserName(profile, accountName) {
  return cleanUserName(profile?.name) || firstAccountName(accountName);
}
export async function readUserProfile(file) {
  try {
    const value = JSON.parse(await fs.readFile(file,"utf8"));
    return {name:cleanUserName(value?.name),onboardingCompleted:value?.onboardingCompleted===true};
  } catch { return {name:"",onboardingCompleted:false}; }
}
export async function saveUserProfile(file, name) {
  if (typeof name !== "string") throw new Error("Имя должно быть текстом.");
  const profile={name:cleanUserName(name),onboardingCompleted:true};
  await fs.mkdir(path.dirname(file),{recursive:true});
  const temporary=file+".tmp";
  await fs.writeFile(temporary,JSON.stringify(profile,null,2),"utf8");
  await fs.rename(temporary,file);
  return profile;
}
