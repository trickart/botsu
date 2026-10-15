// X ログイン画面: ユーザー名を入力して「次へ」を押す(診断ログ付き)
(() => {
  const text = (el) => (el ? (el.innerText || el.textContent || "").trim() : "");
  const inp = document.querySelector("input[name=username], input[autocomplete=username], input:not([type=hidden])");
  console.log("[step1] input=" + (inp ? inp.outerHTML.slice(0, 160) : "none"));
  if (!inp) return;
  const form = inp.closest("form");
  console.log("[step1] form=" + (form ? form.outerHTML.slice(0, 300) : "none"));
  console.log("[step1] form.action=" + (form && form.getAttribute("action")) + " method=" + (form && form.getAttribute("method")));
  document.addEventListener("submit", (e) => console.log("[step1] document saw submit, defaultPrevented=" + e.defaultPrevented + " target=" + e.target.localName), true);
  document.addEventListener("click", (e) => console.log("[step1] document saw click on " + e.target.localName + " phase=" + e.eventPhase), true);
  const setter = Object.getOwnPropertyDescriptor(Element.prototype, "value")?.set;
  inp.focus();
  if (setter) setter.call(inp, "sunameri-test@example.com"); else inp.value = "sunameri-test@example.com";
  inp.dispatchEvent(new InputEvent("input", { bubbles: true, data: "s", inputType: "insertText" }));
  inp.dispatchEvent(new Event("change", { bubbles: true }));
  setTimeout(() => {
    console.log("[step1] input value now=" + JSON.stringify(inp.value) + " name=" + inp.getAttribute("name"));
    const btn = [...document.querySelectorAll("button")].find((b) => /^(Continue|次へ)$/.test(text(b)));
    console.log("[step1] button=" + (btn ? btn.outerHTML.slice(0, 120) : "none") + " disabled=" + (btn && btn.disabled) + " form=" + (btn && btn.form && btn.form.localName));
    if (!btn) return;
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true });
    const ok = btn.dispatchEvent(ev);
    console.log("[step1] click dispatched, not prevented=" + ok);
    if (ok && btn.form) {
      const sev = new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: btn });
      const sok = btn.form.dispatchEvent(sev);
      console.log("[step1] submit dispatched, not prevented=" + sok + " navigate fn=" + typeof __blitz_navigate);
      if (sok) btn.form.submit();
    }
  }, 1000);
})();
