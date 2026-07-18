/**
 * /api/deposit.js — Manual + Monnify
 *
 * GET  ?action=method                      → active deposit method
 * GET  ?action=status&ref=XXX               → deposit status (manual path)
 * GET  ?action=monnify-account&user_id=&email=&name= → get/create the user's
 *      PERMANENT Monnify reserved account (lazy — created on first visit,
 *      reused forever after)
 * POST ?action=initiate-manual              → create manual deposit + narration
 *
 * Env vars needed for Monnify:
 *   MONNIFY_API_KEY
 *   MONNIFY_SECRET_KEY
 *   MONNIFY_CONTRACT_CODE
 *   MONNIFY_BASE_URL   (defaults to live: https://api.monnify.com)
 */

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const MONNIFY_BASE = process.env.MONNIFY_BASE_URL || "https://api.monnify.com";

function genNarration(uid) {
  // No dashes — bank transfer description fields often strip/mangle
  // special characters, which breaks matching. Plain alphanumeric survives.
  return `ARD${uid.replace(/-/g,"").slice(0,5).toUpperCase()}${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}
function genRef(prefix, uid) {
  return `${prefix}${uid.replace(/-/g,"").slice(0,6).toUpperCase()}${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}

// ── Monnify auth — OAuth2 client-credentials, token cached in memory
//    per invocation (serverless, so no persistent cache across calls;
//    each cold/warm call gets a fresh token, which is fine at this volume) ──
async function getMonnifyToken() {
  const auth = Buffer.from(`${process.env.MONNIFY_API_KEY}:${process.env.MONNIFY_SECRET_KEY}`).toString("base64");
  const res = await fetch(`${MONNIFY_BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/json" },
  });
  const data = await res.json();
  if (!data?.responseBody?.accessToken) throw new Error("Could not authenticate with Monnify");
  return data.responseBody.accessToken;
}

// ── Create a reserved (permanent) account for a user ──────────────────────────
async function createMonnifyReservedAccount(userId, email, name) {
  const token = await getMonnifyToken();
  const accountRef = `ARD-${userId}`;

  const res = await fetch(`${MONNIFY_BASE}/api/v2/bank-transfer/reserved-accounts`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      accountReference: accountRef,
      accountName: name || "Aradel User",
      currencyCode: "NGN",
      contractCode: process.env.MONNIFY_CONTRACT_CODE,
      customerEmail: email,
      customerName: name || "Aradel User",
      getAllAvailableBanks: false, // one dedicated account is enough
    }),
  });

  const data = await res.json();
  if (!data?.responseBody) {
    throw new Error(data?.responseMessage || "Monnify rejected the account creation request");
  }

  const acct = data.responseBody.accounts?.[0];
  if (!acct) throw new Error("Monnify did not return an account");

  return {
    account_reference: accountRef,
    account_number: acct.accountNumber,
    bank_name: acct.bankName,
    bank_code: acct.bankCode,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.status(200).end();

  const { action } = req.query;

  // GET: active method
  if(req.method==="GET" && action==="method") {
    const { data } = await supabase.from("site_settings").select("value").eq("key","deposit_method").single();
    return res.json({ ok:true, method: data?.value || "manual" });
  }

  // GET: manual deposit status
  if(req.method==="GET" && action==="status") {
    const { ref } = req.query;
    if(!ref) return res.status(400).json({ error:"ref required" });
    const { data } = await supabase.from("deposits").select("status,amount,paid_at").eq("reference",ref).single();
    if(!data) return res.status(404).json({ error:"not found" });
    return res.json({ ok:true, ...data });
  }

  // GET: Monnify reserved account (create lazily if it doesn't exist yet)
  if(req.method==="GET" && action==="monnify-account") {
    const { user_id, email, name } = req.query;
    if(!user_id) return res.status(400).json({ error:"user_id required" });

    const { data:profile } = await supabase.from("profiles")
      .select("monnify_account_number,monnify_bank_name,monnify_account_ref")
      .eq("id", user_id).single();

    if(profile?.monnify_account_number) {
      return res.json({
        ok: true,
        account_number: profile.monnify_account_number,
        bank_name: profile.monnify_bank_name,
        account_name: name || "Aradel User",
      });
    }

    try {
      const acct = await createMonnifyReservedAccount(user_id, email, name);
      await supabase.from("profiles").update({
        monnify_account_number: acct.account_number,
        monnify_bank_name: acct.bank_name,
        monnify_bank_code: acct.bank_code,
        monnify_account_ref: acct.account_reference,
        updated_at: new Date().toISOString(),
      }).eq("id", user_id);

      return res.json({
        ok: true,
        account_number: acct.account_number,
        bank_name: acct.bank_name,
        account_name: name || "Aradel User",
      });
    } catch(e) {
      console.error("[monnify-account]", e);
      return res.status(500).json({ error: e.message || "Could not create your Monnify account. Try again." });
    }
  }

  if(req.method!=="POST") return res.status(405).json({ error:"Method not allowed" });

  const { user_id, amount } = req.body;

  // POST: initiate-manual
  if(action==="initiate-manual") {
    if(!user_id || !amount) return res.status(400).json({ error:"user_id and amount required" });
    const num = Number(amount);
    if(num < 500) return res.status(400).json({ error:"Minimum deposit is ₦500" });

    const reference = genRef("MAN", user_id);
    const narration = genNarration(user_id);

    const { error } = await supabase.from("deposits").insert({
      user_id, amount:num, reference, narration,
      status:"pending", method:"manual", provider:"manual",
      created_at: new Date().toISOString(),
    });
    if(error) return res.status(500).json({ error:error.message });

    return res.json({
      ok:true, reference, narration, amount:num,
      bank_name:"OPay", account_number:"6416919879", account_name:"UFUMWEN DESTINY IKPONMWOSA"
    });
  }

  return res.status(400).json({ error:"Unknown action: " + action });
};
