import { Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

/**
 * Static pages: privacy policy, terms of use (drafts - to be reviewed by the channel owner) and "not found".
 * The page is chosen by the route's data.page.
 */
@Component({
  selector: 'app-static-page',
  imports: [RouterLink],
  templateUrl: './static-page.component.html',
  styleUrl: './static-page.component.scss'
})
export class StaticPageComponent {
  readonly page: 'privacy' | 'terms' | 'not-found' = inject(ActivatedRoute).snapshot.data['page'] ?? 'not-found';
  readonly updated = '11.10.2026';
}
