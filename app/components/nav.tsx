"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const PAGES = [
  { href: "/", label: "Overview" },
  { href: "/pnl", label: "P&L" },
  { href: "/marketing", label: "Marketing" },
  { href: "/products", label: "Products" },
  { href: "/customers", label: "Customers" },
  { href: "/inventory", label: "Inventory" },
  { href: "/cash", label: "Cash" },
  { href: "/data-quality", label: "Data quality" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav>
      {PAGES.map((page) => (
        <Link
          key={page.href}
          href={page.href}
          aria-current={pathname === page.href ? "page" : undefined}
        >
          {page.label}
        </Link>
      ))}
    </nav>
  );
}
