# Lock site keys to the client's domains

channel: tumblr
kind: value

When building client sites, a site key that works on any domain can be borrowed, allowing spammers to target forms. To prevent this, lock site keys to the client's domains using a domain allowlist. This way, even if a key is compromised, it won't work on other domains. 

Allowlisting production and staging hosts, separating keys per environment, and removing old domains after a migration can help prevent unauthorized access. Server-side verification on every form adds an extra layer of security. Monitoring verify failures and having a spam incident response plan in place can also help mitigate attacks. 

By taking these steps, you can help protect your clients' sites from contact-form spam and ensure a more secure user experience.

#WebDev #WebAgency #Freelance
