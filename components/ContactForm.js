"use client";
import { useState } from "react";

export default function ContactForm() {
  const [form, setForm] = useState({ name: "", email: "", message: "" });
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");

  const onChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const onSubmit = async (e) => {
    e.preventDefault();
    setStatus("loading");
    setError("");
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong");
      setStatus("success");
      setForm({ name: "", email: "", message: "" });
    } catch (err) {
      setError(err.message);
      setStatus("error");
    }
  };

  return (
    <form onSubmit={onSubmit} className="form">
      <input name="name" placeholder="Your name" value={form.name} onChange={onChange} required />
      <input name="email" type="email" placeholder="Email" value={form.email} onChange={onChange} required />
      <textarea name="message" rows={5} placeholder="Your message" value={form.message} onChange={onChange} required />
      <button type="submit" disabled={status === "loading"}>
        {status === "loading" ? "Sending..." : "Send message"}
      </button>
      {status === "success" && <p className="ok">Thanks! Your message has been sent.</p>}
      {status === "error" && <p className="err">{error}</p>}
    </form>
  );
}
