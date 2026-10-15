import ContactForm from "@/components/ContactForm";

export default function Home() {
  return (
    <main className="wrap">
      <section className="hero">
        <h1>Build. Launch. Grow.</h1>
        <p>A fast Next.js site with a real backend. Replace this copy with your own.</p>
      </section>
      <section className="card">
        <h2>Get in touch</h2>
        <ContactForm />
      </section>
    </main>
  );
}
