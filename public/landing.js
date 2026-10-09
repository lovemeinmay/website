// Little pink paw prints drifting down behind the wordmark, at random spots, sizes, speeds and angles.
(function makePaws() {
	const paws = document.getElementById("paws");
	const count = window.innerWidth < 640 ? 14 : 30;

	for (let i = 0; i < count; i++) {
		const paw = document.createElement("i");
		const size = 12 + Math.random() * 16;
		paw.style.left = `${Math.random() * 100}%`;
		paw.style.width = `${size}px`;
		paw.style.height = `${size}px`;
		paw.style.opacity = (0.18 + Math.random() * 0.45).toFixed(2);
		paw.style.setProperty("--spin", `${-40 + Math.random() * 80}deg`);
		paw.style.setProperty("--y", `${Math.random() * 95}vh`);
		paw.style.animationDuration = `${9 + Math.random() * 9}s`;
		paw.style.animationDelay = `${-Math.random() * 18}s`;
		paws.appendChild(paw);
	}
})();

if (new URLSearchParams(location.search).get("login") === "failed") {
	document.getElementById("loginFailed").hidden = false;
}

// Already signed in? Offer the dashboard instead of the sign-in button.
fetch("/api/me")
	.then((response) => response.json())
	.then((data) => {
		if (data.user) {
			document.getElementById("signIn").hidden = true;
			document.getElementById("openLicense").hidden = false;
		}
	})
	.catch(() => {});
