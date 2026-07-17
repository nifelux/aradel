/* assets/js/supabase.js
   ⚠️ PUT YOUR REAL SUPABASE CREDENTIALS BELOW
   Supabase Dashboard → Settings → API */
(function () {
  var SUPABASE_URL  = "YOUR_SUPABASE_URL";      // https://xxxx.supabase.co
  var SUPABASE_ANON = "YOUR_SUPABASE_ANON_KEY";  // eyJhbGci...

  if (!SUPABASE_URL || SUPABASE_URL === "YOUR_SUPABASE_URL") {
    console.error("❌ ARADEL: Supabase not configured. Edit assets/js/supabase.js");
    return;
  }
  if (typeof window.supabase === "undefined") {
    console.error("❌ ARADEL: @supabase/supabase-js not loaded yet.");
    return;
  }

  window.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true }
  });
  console.log("✅ Aradel: Supabase ready");
})();
