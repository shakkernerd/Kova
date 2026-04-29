import "kova-intentionally-missing-runtime-dep";
import { definePluginEntry } from "openclaw/plugin-sdk/core";

export default definePluginEntry({
  id: "kova-missing-runtime-dep",
  name: "Kova Missing Runtime Dep",
  description: "External plugin fixture that should fail with a missing dependency diagnostic.",
  register() {}
});
