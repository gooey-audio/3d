import type { Metadata } from "next";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Sign in · gooey-studio" };

export default function LoginPage() {
  return (
    <div className="login">
      <LoginForm />
    </div>
  );
}
