export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-6 py-16 text-zinc-950">
      <section className="w-full max-w-2xl rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-zinc-500">
          Island Murphy Beds
        </p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight">
          50% Deposit Checkout Backend
        </h1>
        <p className="mt-4 leading-7 text-zinc-600">
          This service creates Shopify draft-order checkout links for the initial
          50% deposit. The remaining 50% is recorded for manual billing by the merchant.
        </p>
      </section>
    </main>
  );
}
