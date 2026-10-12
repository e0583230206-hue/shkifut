import { Component, OnInit } from '@angular/core';
import { AdminService } from '../../../services/admin.service';
import { NbButtonModule, NbCardModule, NbToastrService, NbIconModule, NbInputModule } from "@nebular/theme";

import { FormsModule } from '@angular/forms';
import { Setting } from '../../../models/setting.model';
import { ChatService } from '../../../services/chat.service';

@Component({
  selector: 'app-settings',
  imports: [
    NbCardModule,
    NbButtonModule,
    NbIconModule,
    NbInputModule,
    FormsModule
],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss'
})
export class SettingsComponent implements OnInit {

  settings: Setting[] = [];
  setInProgress: boolean = false;

  readonly moderationLevels = [
    { value: 'strict', label: 'מחמיר: כל דמות שלא זוהתה בוודאות כגבר מטושטשת' },
    { value: 'normal', label: 'רגיל: ספים מתונים יותר, טעות בודדת של המודל לא מטשטשת' },
    { value: 'lenient', label: 'מקל: דמויות קטנות ורחוקות בלי פנים נשארות גלויות' },
  ];

  readonly watermarkPositions = [
    { value: 'bottom-left', label: 'למטה משמאל' },
    { value: 'bottom-right', label: 'למטה מימין' },
    { value: 'top-left', label: 'למעלה משמאל' },
    { value: 'top-right', label: 'למעלה מימין' },
    { value: 'center', label: 'במרכז' },
  ];

  private getSetting(key: string): any {
    return this.settings.find(s => s.key === key)?.value;
  }

  private setSetting(key: string, value: any) {
    const setting = this.settings.find(s => s.key === key);
    if (setting) {
      setting.value = value;
    } else {
      this.settings.push({ key, value });
    }
  }

  get moderationLevel(): string {
    return this.getSetting('moderation_level') || 'strict';
  }

  setModerationLevel(value: string) {
    this.setSetting('moderation_level', value);
  }

  // Watermark (applied by the server to every image readers get, after any blurring)
  get wmEnabled(): boolean {
    const v = this.getSetting('watermark_enabled');
    return v === true || v === 'true';
  }
  set wmEnabled(v: boolean) { this.setSetting('watermark_enabled', v); }

  get wmPosition(): string { return this.getSetting('watermark_position') || 'bottom-left'; }
  set wmPosition(v: string) { this.setSetting('watermark_position', v); }

  get wmSize(): number { return Number(this.getSetting('watermark_size')) || 18; }
  set wmSize(v: number) { this.setSetting('watermark_size', Number(v)); }

  get wmOpacity(): number { return Number(this.getSetting('watermark_opacity')) || 70; }
  set wmOpacity(v: number) { this.setSetting('watermark_opacity', Number(v)); }

  get logoUrl(): string { return this.chatService.channelInfo?.logoUrl || ''; }

  constructor(
    private adminService: AdminService,
    private tostService: NbToastrService,
    private chatService: ChatService,
  ) { }

  ngOnInit(): void {
    this.adminService.getSettings()
      .then(settings => this.settings = settings || []);
  }

  saveSettings() {
    this.setInProgress = true;
    this.adminService.setSettings(this.settings)
      .then(() => this.tostService.success('', 'השינוים נשמרו בהצלחה!'))
      .catch(() => this.tostService.danger('', 'שגיאה בשמירת השינוים'));
    this.setInProgress = false;
  }

  removeSetting(index: number) {
    // if (!confirm('האם אתה בטוח שברצונך למחוק את ההגדרה הזו?')) return;
    this.settings.splice(index, 1);
  }
}
