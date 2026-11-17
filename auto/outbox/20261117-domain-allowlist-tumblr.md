# Lock site keys to the client's domains

channel: tumblr
kind: value

When building and maintaining client sites, contact-form spam can be a significant issue. Server-side verification on every form helps mitigate this problem. However, a site key that works on any domain can be borrowed, allowing spammers to use it on their own sites. To prevent this, it's essential to lock site keys to the client's domains. 

Allowlisting production and staging hosts, separating keys per environment, and removing old domains after a migration can help. This approach ensures that the site key is only usable on authorized domains, reducing the risk of spam. Additionally, monitoring verify failures and having a spam incident response plan in place can help quickly identify and address any issues that arise. By taking these steps, you can help protect your clients' sites from spam and ensure a more secure user experience.

#WebDev #WebAgency #Freelance
