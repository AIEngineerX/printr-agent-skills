# Wallet Integration (Frontend)

This doc is **substantially identical** to pump.fun's `tokenized-agents/WALLET_INTEGRATION.md` **[pump.fun]**. The Solana wallet-adapter stack is platform-agnostic — the same `useWallet()`, `useConnection()`, `signTransaction` flow works whether you're paying a pump.fun tokenized agent or a Printr POB token's treasury.

Upstream reference (always authoritative): https://raw.githubusercontent.com/pump-fun/pump-fun-skills/refs/heads/main/tokenized-agents/references/WALLET_INTEGRATION.md

## Install

```bash
npm install @solana/wallet-adapter-react @solana/wallet-adapter-react-ui @solana/wallet-adapter-wallets
```

## WalletProvider component (Next.js App Router)

```tsx
"use client";

import { useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider as SolanaWalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
  BackpackWalletAdapter,
} from "@solana/wallet-adapter-wallets";

import "@solana/wallet-adapter-react-ui/styles.css";

export default function WalletProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const endpoint =
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
    "https://api.mainnet-beta.solana.com";

  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
      new BackpackWalletAdapter(),
    ],
    [],
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <SolanaWalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}
```

## Wrap the app layout

```tsx
import WalletProvider from "./components/WalletProvider";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
```

## PaymentButton component — talks to `printr-agent-payments`

```tsx
"use client";

import { useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Transaction } from "@solana/web3.js";

type CreateInvoiceResponse = {
  transaction: string;
  invoice: {
    memo: string;
    user_wallet: string;
    currency_mint: string;
    amount_smallest_unit: string;
    start_time: number;
    end_time: number;
  };
};

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export function PaymentButton(props: {
  sessionId: string;
  currency: "SOL" | "USDC";
  priceSmallestUnit: string;   // stringified bigint
  purpose: string;
  onPaid: () => void;
}) {
  const { publicKey, signTransaction, connected } = useWallet();
  const { connection } = useConnection();
  const [state, setState] = useState<"idle" | "building" | "signing" | "submitting" | "verifying" | "done" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);

  async function handlePay() {
    if (!connected || !publicKey || !signTransaction) {
      setErr("connect a wallet first");
      setState("error");
      return;
    }
    setErr(null);

    setState("building");
    const { transaction, invoice } = await postJson<CreateInvoiceResponse>(
      "/api/pay/invoice",
      {
        session_id: props.sessionId,
        user_wallet: publicKey.toBase58(),
        currency: props.currency,
        price_smallest_unit: props.priceSmallestUnit,
        purpose: props.purpose,
      },
    );

    setState("signing");
    const tx = Transaction.from(Buffer.from(transaction, "base64"));
    const signed = await signTransaction(tx);

    setState("submitting");
    const sig = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );

    setState("verifying");
    const { paid } = await postJson<{ paid: boolean }>("/api/pay/verify", {
      memo: invoice.memo,
    });

    if (paid) {
      setState("done");
      props.onPaid();
    } else {
      setErr("payment could not be verified on-chain");
      setState("error");
    }
  }

  return (
    <div>
      <WalletMultiButton />
      {connected && publicKey && (
        <button onClick={handlePay} disabled={state !== "idle" && state !== "error" && state !== "done"}>
          {state === "idle" && `Pay ${formatPrice(props.priceSmallestUnit, props.currency)}`}
          {state === "building" && "Preparing…"}
          {state === "signing" && "Approve in wallet…"}
          {state === "submitting" && "Submitting…"}
          {state === "verifying" && "Verifying…"}
          {state === "done" && "Paid"}
          {state === "error" && "Retry"}
        </button>
      )}
      {err && <p role="alert">{err}</p>}
    </div>
  );
}

function formatPrice(smallestUnit: string, currency: "SOL" | "USDC"): string {
  const n = BigInt(smallestUnit);
  if (currency === "SOL") {
    const sol = Number(n) / 1e9;
    return `${sol.toFixed(3)} SOL`;
  }
  const usdc = Number(n) / 1e6;
  return `${usdc.toFixed(2)} USDC`;
}
```

## Hook usage notes

- **Call `useWallet()` and `useConnection()` only at the top level** of your component. Do NOT call them inside event handlers or async helpers. Pass `signTransaction` and `connection` down as parameters. **[pump.fun]**
- `signTransaction` can be `undefined` (e.g. if the wallet is connected but doesn't expose signing — rare but possible for some embedded wallets). Always guard.
- `WalletMultiButton` is pump.fun's default; you can swap for `WalletDisconnectButton` or a custom UI. The underlying `useWallet()` API is identical.

## Wallet SSR note (Next.js)

The wallet-adapter stack touches `window`, so the provider must be client-only. Mark it with `"use client"` (as above). If you import it into a server component, Next will throw at build time.
