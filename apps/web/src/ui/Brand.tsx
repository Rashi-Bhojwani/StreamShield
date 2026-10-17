import { Link } from "react-router-dom";
import { Icon } from "./Icon";
export function Brand({ product = "Live" }: { product?: "Live" | "Control" }) {
  return (
    <Link
      className="brand"
      to={product === "Live" ? "/" : "/control"}
      aria-label={"StreamShield " + product + " home"}
    >
      <span className="brand-symbol">
        <Icon name="shield" />
      </span>
      <span>
        Stream<span className="brand-accent">Shield</span>
        <span className="brand-product">{product}</span>
      </span>
    </Link>
  );
}
