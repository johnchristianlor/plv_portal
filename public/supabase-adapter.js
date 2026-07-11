import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://zjyqqjurnfxqkczrcjph.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_VS-d2c5pMZFwAeMhIw3HVw_uQc1yC5G";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);