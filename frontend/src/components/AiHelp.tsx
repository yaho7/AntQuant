import { Copy, Sparkles } from "lucide-react";
import * as React from "react";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/primitives";
import { copyText } from "@/lib/clipboard";
import { t } from "@/lib/i18n";
import { aiPrompt, aiRules } from "@/lib/strategyHelp";

export type AiFix = { code: string; problem: string; line?: number | null };

/** The rules for strategy code, as a list for people and as a prompt for AI tools. */
export function AiHelpDialog({ open, onOpenChange, fix }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fix?: AiFix | null;
}) {
  const toast = useToast();
  const [showPrompt, setShowPrompt] = React.useState(!!fix);
  const prompt = React.useMemo(() => aiPrompt(fix ?? undefined), [fix]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl"
        onOpenAutoFocus={(event) => {
          // Start on the copy button rather than selecting the whole prompt.
          event.preventDefault();
          (event.currentTarget as HTMLElement).querySelector<HTMLButtonElement>("[data-copy-prompt]")?.focus();
        }}
        title={t(fix ? "Ask AI to fix it" : "Write a strategy with AI")}
        description={t(fix
          ? "Copy this into the AI tool you use. Paste the code it returns back into the editor."
          : "Copy this prompt into ChatGPT, Claude or another AI, add your idea at the end, then paste the code it writes into the editor.")}>
        {!fix && (
          <>
            <p className="text-xs font-medium text-muted-foreground">{t("The prompt asks the AI to follow these rules:")}</p>
            <ol className="-mt-2 grid list-decimal gap-1.5 pl-5 text-xs text-muted-foreground">
              {aiRules().map((rule) => <li key={rule}>{rule}</li>)}
            </ol>
          </>
        )}
        {showPrompt ? (
          <Textarea readOnly aria-label={t("Prompt")} spellCheck={false} value={prompt}
            className="min-h-48 font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />
        ) : (
          <Button type="button" variant="link" size="sm" className="justify-self-start px-0" onClick={() => setShowPrompt(true)}>
            {t("Show the full prompt")}
          </Button>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("Close")}</Button>
          <Button data-copy-prompt onClick={async () => {
            if (await copyText(prompt)) toast.success(t("Copied. Paste it into your AI tool."));
            else {
              setShowPrompt(true);
              toast.error(t("Copy failed. Select the text and copy it."));
            }
          }}><Copy /> {t("Copy prompt")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AiHelpButton({ fix, label, size = "sm", variant = "ghost" }: {
  fix?: AiFix | null;
  label?: string;
  size?: "sm" | "default";
  variant?: "ghost" | "outline" | "secondary";
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button type="button" size={size} variant={variant} onClick={() => setOpen(true)}>
        <Sparkles /> {label ?? t(fix ? "Ask AI to fix it" : "Writing with AI?")}
      </Button>
      {open && <AiHelpDialog open onOpenChange={setOpen} fix={fix} />}
    </>
  );
}
