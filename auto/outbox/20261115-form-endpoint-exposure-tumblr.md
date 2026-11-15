# Bots post to the endpoint, not the page

channel: tumblr
kind: value

When building client sites, it's easy to overlook form endpoint exposure. Hiding the form does nothing if the endpoint accepts any POST. Bots can still send spam directly to the endpoint, bypassing any client-side checks. To prevent this, find your form endpoints and require a fresh token on each submission. Reject missing tokens with a clear error to help legitimate users diagnose issues. This approach is more effective than relying on puzzles, which can be inaccessible to some users. By verifying every form submission server-side, you can better protect your clients' sites from spam and ensure a more secure user experience.

#WebDev #WebAgency #Freelance
