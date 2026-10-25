import { operator } from "../demo-cli.mjs";
const id = process.argv[2];
if (!id) throw Error("capacity:stop -- RUN_UUID");
operator({ action: "capacity-stop", id });
console.log(
  "Run stopped. Generator grants are revoked; participants disconnect on their next bounded lease check.",
);
