export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <h1 className="text-5xl font-bold tracking-tight sm:text-6xl">
        CultureBridge
      </h1>
      <p className="mt-4 text-xl text-foreground/70 sm:text-2xl">
        Your Cultural Starter Kit for a new city
      </p>
      <p className="mt-6 max-w-lg text-base text-foreground/60">
        Find places that connect to what you already love — with honest evidence
        for every suggestion.
      </p>
      <div className="mt-10 rounded-full border border-foreground/20 px-6 py-2 text-sm text-foreground/50">
        Coming Soon
      </div>
    </main>
  );
}
