import { Component, OnInit, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

/** /m/<id>: the shareable message address (the server adds preview tags). Opens the channel at that message. */
@Component({
  selector: 'app-message-link',
  template: '',
})
export class MessageLinkComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id') ?? '';
    this.router.navigate(['/'], /^\d+$/.test(id) ? { fragment: id, replaceUrl: true } : { replaceUrl: true });
  }
}
