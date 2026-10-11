import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NbButtonModule, NbCardModule, NbCheckboxModule, NbInputModule, NbToastrService } from '@nebular/theme';
import { AdminService } from '../../../services/admin.service';
import { Setting } from '../../../models/setting.model';

/** Ads management. Stored as regular channel settings (see backend/ads.go for the keys). */
@Component({
  selector: 'app-ads-settings',
  imports: [NbCardModule, NbButtonModule, NbInputModule, NbCheckboxModule, FormsModule],
  templateUrl: './ads-settings.component.html',
})
export class AdsSettingsComponent implements OnInit {
  enabled = true;
  src = '';
  width = 300;
  embedCode = '';
  feedEvery = 0;
  feedHeight = 250;
  saving = false;
  private settings: Setting[] = [];

  constructor(private adminService: AdminService, private toastrService: NbToastrService) { }

  async ngOnInit() {
    this.settings = (await this.adminService.getSettings()) || [];
    const get = (k: string) => this.settings.find(s => s.key === k)?.value;
    this.enabled = String(get('ads_enabled') ?? 'true') !== 'false';
    this.src = String(get('ad-iframe-src') ?? '');
    this.width = Number(get('ad-iframe-width') ?? 300) || 300;
    this.embedCode = String(get('ads_embed_code') ?? '');
    this.feedEvery = Number(get('ads_feed_every') ?? 0) || 0;
    this.feedHeight = Number(get('ads_feed_height') ?? 250) || 250;
  }

  async save() {
    this.saving = true;
    const values: Record<string, any> = {
      'ads_enabled': this.enabled,
      'ad-iframe-src': this.src.trim(),
      'ad-iframe-width': Math.max(120, Number(this.width) || 300),
      'ads_embed_code': this.embedCode.trim(),
      'ads_feed_every': Math.max(0, Math.floor(Number(this.feedEvery) || 0)),
      'ads_feed_height': Math.max(50, Number(this.feedHeight) || 250),
    };
    const rest = this.settings.filter(s => !(s.key in values));
    const next = [...rest, ...Object.entries(values).map(([key, value]) => ({ key, value }))] as Setting[];
    try {
      await this.adminService.setSettings(next);
      this.settings = next;
      this.toastrService.success('', 'הגדרות הפרסומות נשמרו. השינוי יופיע לקוראים בטעינה הבאה של הדף.');
    } catch {
      this.toastrService.danger('', 'שגיאה בשמירת ההגדרות');
    } finally {
      this.saving = false;
    }
  }
}
